//! Cancellable subprocess jobs with progress events.
#![allow(dead_code)] // Job pausing and cancel-all come with the shared job code; Capturely does not use them yet.
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

/// Pause state of a job whose processes run through `run_process_ctl`: the process running now
/// (0 = none) and whether the user paused the job. A process started while the job is paused
/// starts suspended.
#[derive(Clone, Default)]
pub struct PauseCtl {
    pid: Arc<AtomicU32>,
    paused: Arc<AtomicBool>,
    /// Set once the job runs a process it can pause (other jobs refuse to pause).
    pausable: Arc<AtomicBool>,
}

impl PauseCtl {
    fn set_paused(&self, on: bool) -> bool {
        if !self.pausable.load(Ordering::SeqCst) {
            return false;
        }
        self.paused.store(on, Ordering::SeqCst);
        let pid = self.pid.load(Ordering::SeqCst);
        if pid == 0 {
            return true; // between processes: the next one starts paused or not
        }
        set_process_suspended(pid, on)
    }
}

struct JobEntry {
    token: CancellationToken,
    ctl: PauseCtl,
}

#[derive(Default)]
pub struct JobRegistry {
    tokens: Mutex<HashMap<String, JobEntry>>,
}

impl JobRegistry {
    fn register(&self, id: &str) -> (CancellationToken, PauseCtl) {
        let token = CancellationToken::new();
        let ctl = PauseCtl::default();
        self.tokens
            .lock()
            .expect("job registry poisoned")
            .insert(id.to_string(), JobEntry { token: token.clone(), ctl: ctl.clone() });
        (token, ctl)
    }

    /// Pause (suspend its process) or resume a job. False when the job is unknown or cannot pause.
    pub fn set_paused(&self, id: &str, paused: bool) -> bool {
        let ctl = match self.tokens.lock().expect("job registry poisoned").get(id) {
            Some(e) => e.ctl.clone(),
            None => return false,
        };
        ctl.set_paused(paused)
    }

    pub fn finish(&self, id: &str) {
        self.tokens.lock().expect("job registry poisoned").remove(id);
    }

    /// Number of jobs running now.
    pub fn active(&self) -> usize {
        self.tokens.lock().expect("job registry poisoned").len()
    }

    /// Cancel every job (resuming paused ones so they can end); returns how many there were.
    pub fn cancel_all(&self) -> usize {
        let jobs = self.tokens.lock().expect("job registry poisoned");
        for e in jobs.values() {
            let _ = e.ctl.set_paused(false);
            e.token.cancel();
        }
        jobs.len()
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.tokens.lock().expect("job registry poisoned").get(id) {
            Some(e) => {
                e.token.cancel();
                true
            }
            None => false,
        }
    }
}

/// Removes the job from the registry when dropped, whatever the outcome.
pub struct JobGuard<'a> {
    pub registry: &'a JobRegistry,
    pub id: String,
    pub token: CancellationToken,
    pub ctl: PauseCtl,
}

impl<'a> JobGuard<'a> {
    pub fn new(registry: &'a JobRegistry, id: &str) -> Self {
        let (token, ctl) = registry.register(id);
        Self { registry, id: id.to_string(), token, ctl }
    }
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        self.registry.finish(&self.id);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub stage: String,
    /// 0..1, or negative when indeterminate.
    pub progress: f64,
    pub message: Option<String>,
}

pub fn emit_progress(app: &AppHandle, job_id: &str, stage: &str, progress: f64, message: Option<String>) {
    let _ = app.emit(
        "job-progress",
        JobProgress { job_id: job_id.to_string(), stage: stage.to_string(), progress, message },
    );
}

pub struct ProcessOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stderr_tail: String,
}

const STDERR_TAIL: usize = 8 * 1024;

pub fn new_command(program: &std::path::Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: do not flash console windows for background tools.
        // BELOW_NORMAL_PRIORITY_CLASS: FFmpeg and the AI worker (and the processes they start, which
        // inherit it) give way to the app and everything else the user is doing, so the system never
        // lags; with nothing else running they still get the whole CPU.
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    // Own process group (pgid = pid), so a cancel or pause reaches everything the tool starts.
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

#[cfg(unix)]
const KILL: &str = if cfg!(target_os = "android") { "/system/bin/kill" } else { "/bin/kill" };

/// Stop a process and everything it started. The AI worker launches its own children (FFmpeg
/// readers, pip when installing the vision runtime); killing only the worker would leave them running.
async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        // Absolute path: never resolve taskkill through PATH.
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let taskkill = std::path::Path::new(&root).join("System32").join("taskkill.exe");
        let mut cmd = new_command(&taskkill);
        cmd.args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(mut killer) = cmd.spawn() {
            let _ = killer.wait().await;
        }
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // A negative pid addresses the whole process group.
        let _ = tokio::process::Command::new(KILL).args(["-KILL", "--", &format!("-{pid}")]).status().await;
    }
    let _ = child.kill().await;
}

/// Suspend (`on`) or resume a process. Windows: NtSuspendProcess / NtResumeProcess (suspending
/// each thread instead would miss threads started in between). Unix: SIGSTOP / SIGCONT.
fn set_process_suspended(pid: u32, on: bool) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};
        #[link(name = "ntdll")]
        extern "system" {
            fn NtSuspendProcess(process: HANDLE) -> i32;
            fn NtResumeProcess(process: HANDLE) -> i32;
        }
        // SAFETY: the handle is checked, used once and closed; the calls only take the handle.
        unsafe {
            let h = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
            if h.is_null() {
                return false;
            }
            let status = if on { NtSuspendProcess(h) } else { NtResumeProcess(h) };
            CloseHandle(h);
            status >= 0
        }
    }
    #[cfg(unix)]
    {
        std::process::Command::new(KILL)
            .args([if on { "-STOP" } else { "-CONT" }, "--", &format!("-{pid}")])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Run a process, streaming stdout lines to `on_line`. Arguments are passed as an argv
/// array (never through a shell). Cancelling the token kills the process.
pub async fn run_process(
    cmd: Command,
    token: &CancellationToken,
    stdin_data: Option<Vec<u8>>,
    on_line: impl FnMut(&str),
) -> AppResult<ProcessOutput> {
    run_process_ctl(cmd, token, None, stdin_data, on_line).await
}

/// `run_process` for a job that can be paused: the process is recorded in `ctl` while it runs
/// (and starts suspended when the job is paused already).
pub async fn run_process_ctl(
    mut cmd: Command,
    token: &CancellationToken,
    ctl: Option<&PauseCtl>,
    stdin_data: Option<Vec<u8>>,
    mut on_line: impl FnMut(&str),
) -> AppResult<ProcessOutput> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Process(format!("Could not start process: {e}")))?;
    // Forget the process when this call ends, however it ends.
    struct Running<'c>(Option<&'c PauseCtl>);
    impl Drop for Running<'_> {
        fn drop(&mut self) {
            if let Some(c) = self.0 {
                c.pid.store(0, Ordering::SeqCst);
            }
        }
    }
    let _running = Running(ctl);
    if let (Some(c), Some(pid)) = (ctl, child.id()) {
        c.pid.store(pid, Ordering::SeqCst);
        c.pausable.store(true, Ordering::SeqCst);
        if c.paused.load(Ordering::SeqCst) {
            set_process_suspended(pid, true);
        }
    }

    if let (Some(data), Some(mut stdin)) = (stdin_data, child.stdin.take()) {
        stdin.write_all(&data).await?;
        stdin.shutdown().await?;
        drop(stdin);
    }

    let stderr = child.stderr.take().expect("stderr piped");
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_task = {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut chunk = vec![0u8; 4096];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut b = buf.lock().expect("stderr buffer poisoned");
                        b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        if b.len() > STDERR_TAIL * 2 {
                            let cut = b.len() - STDERR_TAIL;
                            let cut = (cut..b.len()).find(|i| b.is_char_boundary(*i)).unwrap_or(cut);
                            b.drain(..cut);
                        }
                    }
                }
            }
        })
    };

    let stdout = child.stdout.take().expect("stdout piped");
    let mut lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                kill_tree(&mut child).await;
                let _ = stderr_task.await;
                return Err(AppError::Cancelled);
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => on_line(&l),
                    Ok(None) => break,
                    Err(e) => return Err(AppError::Process(format!("Failed reading process output: {e}"))),
                }
            }
        }
    }

    let status = tokio::select! {
        _ = token.cancelled() => {
            kill_tree(&mut child).await;
            return Err(AppError::Cancelled);
        }
        s = child.wait() => s?,
    };
    let _ = stderr_task.await;
    let tail = stderr_buf.lock().expect("stderr buffer poisoned").clone();
    let tail = if tail.len() > STDERR_TAIL {
        let start = (tail.len() - STDERR_TAIL..tail.len())
            .find(|i| tail.is_char_boundary(*i))
            .unwrap_or(0);
        tail[start..].to_string()
    } else {
        tail
    };
    Ok(ProcessOutput { success: status.success(), code: status.code(), stderr_tail: tail })
}

/// Last few meaningful lines of stderr for user-facing errors.
pub fn summarize_stderr(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(4);
    lines[start..].join("\n")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Duration;

    fn system32(exe: &str) -> std::path::PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        std::path::Path::new(&root).join("System32").join(exe)
    }

    /// PIDs of the direct children of `parent` (via PowerShell CIM; test helper only).
    fn children(parent: u32) -> Vec<u32> {
        let out = std::process::Command::new(system32(r"WindowsPowerShell\v1.0\powershell.exe"))
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}').ProcessId"),
            ])
            .output()
            .expect("powershell runs");
        String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    }

    fn alive(pid: u32) -> bool {
        let out = std::process::Command::new(system32("tasklist.exe"))
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    // Pause suspends the running process (no output while paused) and resume lets it finish.
    #[tokio::test]
    async fn pause_suspends_and_resume_continues() {
        let registry = JobRegistry::default();
        let guard = JobGuard::new(&registry, "pause-test");
        let lines = Arc::new(Mutex::new(Vec::<std::time::Instant>::new()));
        let seen = lines.clone();
        let mut cmd = new_command(&system32("ping.exe"));
        cmd.args(["-n", "5", "127.0.0.1"]);
        let token = guard.token.clone();
        let ctl = guard.ctl.clone();
        let run = tokio::spawn(async move {
            run_process_ctl(cmd, &token, Some(&ctl), None, |_| seen.lock().unwrap().push(std::time::Instant::now())).await
        });
        // Wait for the first reply, then pause for 2.5 s.
        for _ in 0..50 {
            if lines.lock().unwrap().len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(registry.set_paused("pause-test", true), "the export job could not pause");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let before = lines.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert_eq!(lines.lock().unwrap().len(), before, "output continued while paused");
        assert!(registry.set_paused("pause-test", false));
        let out = run.await.expect("task").expect("process");
        assert!(out.success);
        assert!(lines.lock().unwrap().len() > before, "no output after resuming");
        // A job that never ran a pausable process refuses to pause.
        let _other = JobGuard::new(&registry, "plain");
        assert!(!registry.set_paused("plain", true));
        assert!(!registry.set_paused("unknown", true));
    }

    // Regression: cancelling killed only the worker; processes it started (pip, FFmpeg) kept running.
    #[tokio::test]
    async fn cancel_kills_grandchildren() {
        let mut cmd = new_command(&system32("cmd.exe"));
        cmd.args(["/C", "ping -n 30 127.0.0.1"]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
        let mut child = cmd.spawn().expect("cmd starts");
        let pid = child.id().expect("pid");
        let mut grandchildren = Vec::new();
        for _ in 0..50 {
            grandchildren = children(pid);
            if !grandchildren.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!grandchildren.is_empty(), "ping was not started");
        kill_tree(&mut child).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        for g in grandchildren {
            assert!(!alive(g), "grandchild {g} survived the cancel");
        }
    }
}
