#!/bin/bash
set -e

# Start virtual framebuffer
Xvfb :99 -screen 0 1280x900x24 &
export DISPLAY=:99
sleep 1

# x11vnc (no password — access controlled by single-use token at node-agent level)
x11vnc -display :99 -forever -nopw -xkb -quiet &

# noVNC websockify bridge on port 6080
websockify --web /usr/share/novnc 6080 localhost:5900 &

# Bun capture server — launches Chrome internally via Playwright
exec bun /app/capture-server.ts
