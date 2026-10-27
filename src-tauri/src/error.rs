use serde::{Serialize, Serializer};

/// Errors returned to the UI. Messages are user-facing and must not contain secrets.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    ToolMissing(String),
    #[error("{0}")]
    Process(String),
    #[error("The operation was cancelled.")]
    Cancelled,
    #[error("{0}")]
    Validation(String),
    #[error("File system error: {0}")]
    Io(#[from] std::io::Error),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::Invalid(_) => "invalid_input",
            AppError::ToolMissing(_) => "tool_missing",
            AppError::Process(_) => "process_failed",
            AppError::Cancelled => "cancelled",
            AppError::Validation(_) => "validation_failed",
            AppError::Io(_) => "io_error",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
