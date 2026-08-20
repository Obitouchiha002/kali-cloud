#!/bin/bash
# ===================================================================
#  Boots the real Kali XFCE desktop and streams it to the browser.
#  Flow:  Xtigervnc (virtual screen) -> XFCE (desktop) -> noVNC (web)
#
#  VNC is bound to localhost ONLY and uses SecurityTypes None: the
#  browser never talks to VNC directly — it talks to websockify (6080),
#  which bridges to 127.0.0.1:5901 inside this same container. Access
#  control is enforced by the platform (auth + proxy), not a VNC password.
# ===================================================================
set -e

export USER=kali
export HOME=/home/kali
GEOMETRY="${SCREEN_GEOMETRY:-1440x900}"
VNC_DEPTH="${VNC_DEPTH:-24}"

mkdir -p "$HOME/.vnc"

# --- xstartup: launch the full XFCE desktop ----------------------------------
cat > "$HOME/.vnc/xstartup" <<'XSTART'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XKL_XMODMAP_DISABLE=1
# default shell = zsh so the panel terminal shows the real Kali (kali@kali) prompt
export SHELL=/usr/bin/zsh
exec dbus-launch startxfce4
XSTART
chmod +x "$HOME/.vnc/xstartup"

# --- clean any stale session, then start the VNC-backed X server -------------
vncserver -kill :1 >/dev/null 2>&1 || true
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

echo "[kali-cloud] starting XFCE desktop on :1 (${GEOMETRY})"
vncserver :1 -geometry "$GEOMETRY" -depth "$VNC_DEPTH" -localhost yes -SecurityTypes None

# --- set the Kali wallpaper ---------------------------------------------------
# xfdesktop keys the backdrop by the REAL output name (e.g. VNC-0), not the
# generic "monitor0", so a fresh box shows a black desktop until we set it for
# the actual monitor across every workspace, then restart xfdesktop.
(
  export DISPLAY=:1
  WP="/usr/share/backgrounds/kali/kali-cubes-16x9.jpg"
  [ -f "$WP" ] || WP="$(readlink -f /usr/share/backgrounds/kali-16x9/default 2>/dev/null)"
  for _ in $(seq 1 20); do xrandr 2>/dev/null | grep -qw connected && break; sleep 1; done
  MON="$(xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')"; MON="${MON:-VNC-0}"
  for ws in 0 1 2 3; do
    P="/backdrop/screen0/monitor${MON}/workspace${ws}"
    xfconf-query -c xfce4-desktop -p "$P/last-image" --create -t string -s "$WP" 2>/dev/null
    xfconf-query -c xfce4-desktop -p "$P/image-style" --create -t int -s 5 2>/dev/null
    xfconf-query -c xfce4-desktop -p "$P/image-show"  --create -t bool -s true 2>/dev/null
  done
  pkill xfdesktop 2>/dev/null; sleep 1; nohup xfdesktop >/dev/null 2>&1 &
  # belt-and-suspenders: kill any locker and turn off lock + screen blanking, so
  # the desktop never locks (the lock screen can't verify the password under
  # no-new-privileges and would lock the user out with "incorrect password").
  pkill xfce4-screensaver 2>/dev/null || true
  xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false 2>/dev/null || true
  xfconf-query -c xfce4-screensaver -p /lock/enabled  -n -t bool -s false 2>/dev/null || true
  xset s off 2>/dev/null || true
  xset -dpms 2>/dev/null || true
) &

# --- noVNC: bridge the localhost VNC screen to the browser over WebSocket -----
echo "[kali-cloud] desktop ready -> http://localhost:6080/vnc.html?autoconnect=1&resize=remote"
exec websockify --web=/usr/share/novnc 6080 127.0.0.1:5901
