#!/bin/zsh
cd "$(dirname "$0")"

echo "Starting Hatviz local compute server..."
echo "Leave this window open while using the app."
echo "Press Control-C here to stop the server."
echo

( sleep 1; open "http://127.0.0.1:8765/app.html" ) &
node --max-old-space-size=12288 server.js
