#!/usr/bin/env bash
# Renders the Android launcher icons from the SVG sources in this folder with headless Edge.
# Adaptive foreground = logo mark only (transparent); round = mark on a dark circle.
set -u
cd "$(dirname "$0")"
P="$(pwd -W)"
E="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
R="../../gen/android/app/src/main/res"
shot() { # svg size out
  local tmp; tmp="$(mktemp -d)"
  echo "<html><body style=\"margin:0;background:transparent\"><img src=\"$P/$1\" width=\"$2\" height=\"$2\" style=\"display:block\"></body></html>" > "$tmp/r.html"
  timeout 40 "$E" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$(cygpath -w "$tmp")" \
    --default-background-color=00000000 --screenshot="$(cygpath -w "$3")" --window-size="$2,$2" "file:///$(cygpath -m "$tmp")/r.html" >/dev/null 2>&1
  rm -rf "$tmp"
}
for pair in mdpi:108:48 hdpi:162:72 xhdpi:216:96 xxhdpi:324:144 xxxhdpi:432:192; do
  d=${pair%%:*}; rest=${pair#*:}; fg=${rest%%:*}; rd=${rest#*:}
  shot android-foreground.svg "$fg" "$R/mipmap-$d/ic_launcher_foreground.png"
  shot android-round.svg "$rd" "$R/mipmap-$d/ic_launcher_round.png"
  echo "done $d"
done
printf '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#0E0C15</color>\n</resources>\n' > "$R/values/ic_launcher_background.xml"
