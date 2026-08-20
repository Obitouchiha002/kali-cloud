# ===================================================================
#  Kali-Cloud : REAL full Kali Linux desktop, streamed to a browser
#  Base = official Kali rolling (open source, the real thing).
#  Layers split so the heavy toolset can rebuild without re-downloading
#  the desktop/streaming stack.
# ===================================================================
FROM kalilinux/kali-rolling

ENV DEBIAN_FRONTEND=noninteractive
ENV USER=kali
ENV HOME=/home/kali

# --- Layer 1: desktop + VNC + noVNC + basics (stable, cached) ----------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        kali-desktop-xfce \
        tigervnc-standalone-server tigervnc-common \
        novnc websockify \
        dbus-x11 x11-utils \
        sudo curl nano vim procps \
        fonts-noto fonts-noto-color-emoji && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Layer 2: the Kali toolset (heavy; rebuilds independently) ----------------
#   kali-linux-default  = FULL standard Kali toolset (big) [default]
#   kali-linux-headless = core CLI tools only (faster first build)
ARG METAPACKAGE=kali-linux-default
RUN apt-get update && \
    apt-get install -y --no-install-recommends ${METAPACKAGE} && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Layer 2b: authentic Kali shell UX + common utilities --------------------
# zsh + kali prompt + syntax-highlighting/autosuggestions already ship in Layer 1.
# command-not-found  -> a wrong command suggests "apt install X" like real Kali.
# iputils-ping       -> `ping` (missing by default); works unprivileged via the
#                       ping_group_range sysctl the box is launched with.
# tzdata             -> real local time on the clock instead of UTC.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        command-not-found iputils-ping iputils-tracepath tzdata && \
    ( /usr/lib/cnf-update-db 2>/dev/null || update-command-not-found 2>/dev/null || true ) && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# default timezone (override at build with --build-arg TZ=...)
ARG TZ=Asia/Kolkata
ENV TZ=${TZ}
RUN ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime && echo "${TZ}" > /etc/timezone

# --- non-root 'kali' user (default shell = zsh, like real Kali) ---------------
RUN useradd -m -s /usr/bin/zsh kali && \
    echo "kali:kali" | chpasswd && \
    echo "kali ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/kali && \
    usermod -aG sudo kali && \
    ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html && \
    # nmap ships with file-capabilities that a locked-down container blocks;
    # strip them so nmap runs unprivileged (connect scans work; raw via sudo).
    (setcap -r /usr/lib/nmap/nmap 2>/dev/null || true) && \
    # terminal zoom without Shift: Ctrl+= (in), Ctrl+- (out), Ctrl+0 (reset);
    # also bump the default font a touch. (Ctrl+mouse-wheel zooms too.)
    sed -i 's/^fontSize=.*/fontSize=12/' /etc/xdg/qterminal.org/qterminal.ini && \
    sed -i '/^\[Shortcuts\]/a Zoom%20in=Ctrl+=\nZoom%20out=Ctrl+-\nZoom%20reset=Ctrl+0' \
        /etc/xdg/qterminal.org/qterminal.ini && \
    # NEVER auto-lock this disposable desktop: under no-new-privileges the setuid
    # password-check helper can't read /etc/shadow, so the lock screen rejects even
    # the correct password and traps the user out. Disable the screensaver/locker.
    rm -f /etc/xdg/autostart/xfce4-screensaver.desktop \
          /etc/xdg/autostart/light-locker.desktop 2>/dev/null || true

COPY start-desktop.sh /usr/local/bin/start-desktop.sh
RUN chmod +x /usr/local/bin/start-desktop.sh

EXPOSE 6080
USER kali
WORKDIR /home/kali
CMD ["/usr/local/bin/start-desktop.sh"]
