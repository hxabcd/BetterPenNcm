#!/bin/sh
# netprobe.sh - one-shot network capability probe for Youdao DictPen S7
#
# WHY: the docs contain speed claims (8MB/s, 0.4MB/s, 393KB/s) that were never
# backed by raw output, and they contradict each other by up to 200x. This probe
# replaces all of them with raw numbers measured right now.
#
# It answers exactly one decision: "is a single TCP connection already saturating
# the wifi link, or is there headroom that parallel connections could take?"
#
# Sections:
#   0 preflight      - is the app running (which would pollute results)
#   1 environment    - cpu / mem / iface / route / dns
#   2 wifi link      - rx & tx bitrate, signal, freq   <- the PHY ceiling
#   3 link quality   - ping gateway + public dns (loss / jitter)
#   4 request timing - dns / tcp / tls / first-byte breakdown
#   5 range support  - 206 or 200 (parallel test needs 206)
#   6 single-conn    - throughput x3
#   7 parallel       - throughput at 2 and 4 connections
#   8 endpoints      - reachability of the real endpoints
#   9 summary        - ceiling vs measured, and a check of the "8MB/s" claim
#
# Usage (on device):
#   sh /tmp/netprobe.sh "<URL>" [PC_IP]
# Usage (from host):   （设备序列号用你的实际值替换 <SERIAL>）
#   adb -s <SERIAL> push scripts/netprobe.sh /tmp/
#   adb -s <SERIAL> shell "sh /tmp/netprobe.sh 'https://...'" > netprobe_1.txt
#
# IMPORTANT: stop the miniapp (or make sure it is idle) before measuring,
# otherwise background caching / streaming will steal bandwidth.
#
# NO bc, NO bash arrays, NO [[ ]] - busybox ash compatible.
# ASCII only - do not put non-ASCII bytes in this file.

URL="$1"
PCIP="$2"
# URL may also be supplied via a file, to dodge shell-quoting hell:
#   echo "<url>" > /tmp/netprobe_url.txt
if [ -z "$URL" ] && [ -f /tmp/netprobe_url.txt ]; then
  URL=$(head -1 /tmp/netprobe_url.txt | tr -d '\r\n')
fi
OUT=/tmp/netprobe_result.txt
UA='Mozilla/5.0 (Linux; arm; Android 10) AppleWebKit/537.36'

: > "$OUT"

say() { printf '%s\n' "$@" | tee -a "$OUT"; }
sec() { printf '%s\n' "------------------------------------------------------------" | tee -a "$OUT"; }
now() { date +%s; }

# ---------------------------------------------------------------- 0 preflight
sec
say "== 0. PREFLIGHT =="
say "date        : $(date)"
say "curl        : $(curl --version 2>/dev/null | head -1)"
say "id          : $(id 2>/dev/null)"
APP=$(ps 2>/dev/null | grep -i miniapp | grep -v grep | head -3)
if [ -n "$APP" ]; then
  say "APP RUNNING : yes (results may be polluted by bg download/stream)"
  say "$APP"
else
  say "APP RUNNING : no (clean)"
fi
if [ -z "$URL" ]; then
  say "URL         : (none given - link/environment only)"
else
  say "URL         : $URL"
fi

# -------------------------------------------------------------- 1 environment
sec
say "== 1. ENVIRONMENT =="
say "kernel      : $(uname -srm 2>/dev/null)"
say "cpu model   : $(grep -i 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2- | sed 's/^ *//')"
say "cpu cores   : $(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
say "cpu part    : $(grep -i 'CPU part' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2- | sed 's/^ *//')"
say "loadavg     : $(cat /proc/loadavg 2>/dev/null)"
say "mem         : $(free 2>/dev/null | grep -i 'mem:' | tr -s ' ')"
say "libc        : $(ls -l /lib/libc.so* /lib/libuClibc* 2>/dev/null | head -3)"
say "libcurl     : $(ls -l /usr/lib/libcurl* /lib/libcurl* 2>/dev/null | head -3)"

WIFI=""
for d in /sys/class/net/*; do
  n=$(basename "$d")
  if [ -d "$d/wireless" ] || [ -e "$d/phy80211" ]; then WIFI="$n"; break; fi
done
[ -z "$WIFI" ] && WIFI=wlan0
say "wifi iface  : $WIFI"

say "-- ip addr --"
ip -o addr 2>/dev/null | tee -a "$OUT"
say "-- route --"
ip route 2>/dev/null | tee -a "$OUT"
say "-- resolv.conf --"
cat /etc/resolv.conf 2>/dev/null | tee -a "$OUT"

# ----------------------------------------------------------------- 2 wifi link
sec
say "== 2. WIFI LINK (PHY CEILING) =="
if command -v iw >/dev/null 2>&1; then
  say "-- iw dev $WIFI link --"
  iw dev "$WIFI" link 2>&1 | tee -a "$OUT"
  say "-- iw dev $WIFI info --"
  iw dev "$WIFI" info 2>&1 | tee -a "$OUT"
else
  say "iw not found"
fi
if command -v iwconfig >/dev/null 2>&1; then
  say "-- iwconfig $WIFI --"
  iwconfig "$WIFI" 2>&1 | tee -a "$OUT"
fi
say "-- /proc/net/wireless --"
cat /proc/net/wireless 2>/dev/null | tee -a "$OUT"

# -------------------------------------------------------------- 3 link quality
sec
say "== 3. LINK QUALITY =="
GW=$(ip route 2>/dev/null | grep '^default' | head -1 | awk '{print $3}')
say "gateway     : ${GW:-unknown}"
if [ -n "$GW" ]; then
  say "-- ping gateway x10 --"
  ping -c 10 -W 2 "$GW" 2>&1 | tail -3 | tee -a "$OUT"
fi
say "-- ping 223.5.5.5 (aliDNS) x10 --"
ping -c 10 -W 2 223.5.5.5 2>&1 | tail -3 | tee -a "$OUT"

if [ -z "$URL" ]; then
  sec
  say "no URL given - skipping sections 4-7"
  sec
  cp -f "$OUT" /userdisk/netprobe_result.txt 2>/dev/null
  say "(saved: $OUT and /userdisk/netprobe_result.txt)"
  exit 0
fi

# ------------------------------------------------------------ 4 request timing
sec
say "== 4. REQUEST TIMING (one request) =="
curl -s -o /dev/null --max-time 30 -w \
  'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} firstbyte=%{time_starttransfer} total=%{time_total} http=%{http_code} bytes=%{size_download}\n' \
  "$URL" 2>&1 | tee -a "$OUT"

HOST=$(echo "$URL" | sed -n 's|^https\{0,1\}://\([^/:]*\).*|\1|p')
say "host        : $HOST"
say "resolved    : $(nslookup "$HOST" 2>/dev/null | grep -A1 'Name:' | tail -1 | awk '{print $2}')"

# --------------------------------------------------------------- 5 range check
sec
say "== 5. RANGE SUPPORT =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -r 0-1023 "$URL" 2>/dev/null)
say "range 0-1023 -> http=$CODE  (206=ok, 200=range ignored, parallel test needs 206)"
say "-- headers (content-length / accept-ranges) --"
curl -sI --max-time 20 "$URL" 2>/dev/null | tr -d '\r' | grep -i 'content-length\|accept-ranges\|content-type\|server' | tee -a "$OUT"
SZ=$(curl -sI --max-time 20 "$URL" 2>/dev/null | tr -d '\r' | grep -i '^content-length' | awk '{print $2}')
say "size bytes  : ${SZ:-unknown}"

# Fixed probe window: single vs parallel must fetch the SAME byte count or the
# comparison is meaningless. Default 8MB; override with PROBE_BYTES=<n>.
PROBE_BYTES="${PROBE_BYTES:-8388608}"
case "$PROBE_BYTES" in ''|*[!0-9]*) PROBE_BYTES=8388608 ;; esac
if [ -n "$SZ" ] && [ "$SZ" -lt "$PROBE_BYTES" ]; then
  PROBE_BYTES="$SZ"
  say "note        : file < probe window, will fetch the whole file"
fi
RANGE_OPT=""
if [ -n "$SZ" ] && [ "$PROBE_BYTES" -lt "$SZ" ]; then
  RANGE_OPT="-r 0-$((PROBE_BYTES - 1))"
fi
say "probe window: ${PROBE_BYTES} bytes (fixed, so single vs parallel are comparable)"
if [ "$PROBE_BYTES" -lt 2097152 ]; then
  say "WARN        : probe window < 2MB, the 1s clock resolution will dominate."
fi

# ------------------------------------------------------------ 6 single-conn x3
sec
say "== 6. SINGLE CONNECTION THROUGHPUT (x3) =="
BEST1=0
i=1
while [ "$i" -le 3 ]; do
  R=$(curl -s -o /dev/null --max-time 180 $RANGE_OPT \
    -H "User-Agent: $UA" \
    -w '%{size_download} %{time_total} %{speed_download}' "$URL" 2>&1)
  B=$(echo "$R" | awk '{print $1}')
  T=$(echo "$R" | awk '{print $2}')
  S=$(echo "$R" | awk '{print $3}')
  KB=$(echo "$S" | awk '{printf "%d", $1/1024}')
  say "  run$i: bytes=$B time=${T}s speed=${S}B/s => ${KB} KB/s"
  if [ "$KB" -gt "$BEST1" ]; then BEST1="$KB"; fi
  i=$((i + 1))
done
say "  best single-conn: ${BEST1} KB/s"

# --------------------------------------------------- 6b link rate UNDER LOAD
# Reading rx bitrate while IDLE is useless: the AP falls back to the lowest
# basic rate. Measured: idle showed 11.0 Mbit/s while the real
# download rate was 150.0 Mbit/s (HT40 MCS7) - a 13x error that would have
# wrecked the PHY-ceiling calculation. Always sample while bytes are flowing.
sec
say "== 6b. LINK RATE UNDER LOAD =="
LOAD_RX=""
curl -s -o /dev/null --max-time 60 -r 0-8388607 -H "User-Agent: $UA" "$URL" &
CP=$!
sleep 1
LOAD_RX=$(iw dev "$WIFI" link 2>/dev/null | sed -n 's/.*rx bitrate:[[:space:]]*\([0-9.]*\).*/\1/p' | head -1)
wait $CP
IDLE_RX=$(iw dev "$WIFI" link 2>/dev/null | sed -n 's/.*rx bitrate:[[:space:]]*\([0-9.]*\).*/\1/p' | head -1)
say "rx under load: ${LOAD_RX:-?} Mbit/s   <- use this one"
say "rx when idle : ${IDLE_RX:-?} Mbit/s   (NOT reliable - AP uses basic rate)"

# --------------------------------------------------------------- 7 parallel
sec
say "== 7. PARALLEL THROUGHPUT =="
if [ "$CODE" != "206" ]; then
  say "SKIPPED: server does not honor Range (http=$CODE). Parallel needs range support."
else
  if [ -z "$SZ" ]; then
    say "SKIPPED: no content-length, cannot slice."
  else
    par_test() {
      N="$1"
      PART=$((PROBE_BYTES / N))
      T0=$(now)
      i=0
      while [ "$i" -lt "$N" ]; do
        A=$((i * PART))
        B=$((A + PART - 1))
        if [ "$i" -eq "$((N - 1))" ]; then B=$((PROBE_BYTES - 1)); fi
        curl -s -o /dev/null --max-time 240 -r "$A-$B" \
          -H "User-Agent: $UA" "$URL" &
        i=$((i + 1))
      done
      wait
      T1=$(now)
      DT=$((T1 - T0))
      if [ "$DT" -lt 1 ]; then DT=1; fi
      KBPS=$((PROBE_BYTES / 1024 / DT))
      say "  parallel-${N}: bytes=${PROBE_BYTES} wall=${DT}s => ${KBPS} KB/s"
    }
    par_test 2
    par_test 4
  fi
fi

# --------------------------------------------------------------- 8 endpoints
sec
say "== 8. ENDPOINT REACHABILITY =="
for h in music.163.com; do
  R=$(curl -s -o /dev/null --max-time 15 \
    -w 'http=%{http_code} dns=%{time_namelookup} connect=%{time_connect} total=%{time_total}' \
    "https://$h/" 2>&1)
  say "  $h : $R"
done
if [ -n "$PCIP" ]; then
  say "-- ping PC ($PCIP) x4 --"
  ping -c 4 -W 2 "$PCIP" 2>&1 | tail -2 | tee -a "$OUT"
fi

# ----------------------------------------------------------------- 9 summary
sec
say "== 9. SUMMARY =="
LINK=$(iw dev "$WIFI" link 2>/dev/null)
# Extract with sed anchored on "label:" - field position is unreliable because
# the whitespace between "rx" / "bitrate:" / value varies across iw versions.
RX=$(printf '%s\n' "$LINK" | grep -i 'rx bitrate' | head -1 | sed 's/.*rx bitrate:[^0-9]*\([0-9][0-9.]*\).*/\1/')
TX=$(printf '%s\n' "$LINK" | grep -i 'tx bitrate' | head -1 | sed 's/.*tx bitrate:[^0-9]*\([0-9][0-9.]*\).*/\1/')
SIG=$(printf '%s\n' "$LINK" | grep -i 'signal' | head -1 | sed 's/.*signal:[^0-9-]*\(-\{0,1\}[0-9][0-9.]*\).*/\1/')
FREQ=$(printf '%s\n' "$LINK" | grep -i 'freq' | head -1 | sed 's/.*freq:[^0-9]*\([0-9][0-9.]*\).*/\1/')
# numeric guard: anything that is not a plain number -> treat as unknown
case "$RX" in ''|*[!0-9.]*) RX="" ;; esac
case "$TX" in ''|*[!0-9.]*) TX="" ;; esac
say "signal      : ${SIG:-?} dBm"
say "freq        : ${FREQ:-?} MHz"
say "tx bitrate  : ${TX:-?} Mbit/s"
say "rx bitrate  : ${RX:-?} Mbit/s (idle - NOT reliable)"

# Prefer the under-load sample for the ceiling; fall back to the idle reading.
RX_USE="$LOAD_RX"
case "$RX_USE" in ''|*[!0-9.]*) RX_USE="$RX" ;; esac
say "rx for calc : ${RX_USE:-?} Mbit/s"

if [ -n "$RX_USE" ]; then
  PHY=$(echo "$RX_USE" | awk '{printf "%d", $1*1000/8}')
  say "PHY ceiling : ${PHY} KB/s (rx bitrate / 8)   [real TCP = ~40-60% of this]"
  if [ "$PHY" -gt 0 ] && [ "$BEST1" -gt 0 ]; then
    PCT=$((BEST1 * 100 / PHY))
    say "single-conn : ${BEST1} KB/s => ${PCT}% of PHY ceiling"
    if [ "$PCT" -ge 50 ]; then
      say "VERDICT     : single connection looks healthy. Parallel would add little."
    elif [ "$PCT" -ge 25 ]; then
      say "VERDICT     : some headroom. Parallel may help a bit; measure it above."
    else
      say "VERDICT     : big headroom vs PHY rate. Parallel is worth testing."
    fi
  fi
  if [ "$PHY" -ge 7500 ] && [ "$PHY" -le 9500 ]; then
    say "NOTE        : PHY ceiling lands in 7500-9500 KB/s (7.3-9.3 MB/s)."
    say "              The old docs claim curl measured ~8MB/s. Compare that with"
    say "              the single-conn number above - if single-conn is far lower,"
    say "              the old '8MB/s' was the PHY negotiated rate, not throughput."
  fi
fi

sec
cp -f "$OUT" /userdisk/netprobe_result.txt 2>/dev/null
say "(saved: $OUT and /userdisk/netprobe_result.txt)"
say "== DONE =="
