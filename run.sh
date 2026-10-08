#!/usr/bin/env bash
# Serves the simulator locally (ES modules need http://, not file://)
cd "$(dirname "$0")" || exit 1
PORT="${1:-8023}"

# If the port is taken, try the next few
port_free() { python3 -c "import socket,sys; sys.exit(socket.socket().connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0)" "$1"; }
for _ in $(seq 1 20); do
  port_free "$PORT" && break
  echo "Port $PORT is busy, trying $((PORT + 1))..."
  PORT=$((PORT + 1))
done

URL="http://localhost:$PORT"
echo "Charged Up Sim → $URL   (Ctrl+C to stop)"
# open the browser once the server is up
( sleep 1; xdg-open "$URL" >/dev/null 2>&1 ) &
# no-cache headers so the browser always loads the latest code after updates
python3 - "$PORT" <<'PY'
import sys, http.server
http.server.ThreadingHTTPServer.allow_reuse_address = True
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
status=$?
if [ $status -ne 0 ]; then
  echo "Server exited with an error (code $status)."
  read -rp "Press Enter to close..." _
fi
