PASS=0
FAIL=0
FAILED_MSGS=()
ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); FAILED_MSGS+=("$1"); echo "FAIL  $1"; }

# 断言工具（日志行形如 [12:34:56][nav] ...）
assert_has() {
  local desc="$1" pat="$2" min="${3:-1}" n
  n=$(grep -cF -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -ge "$min" ]; then ok "$desc（$n 次）"; else bad "$desc（${n:-0} 次，期望 ≥$min；pattern: $pat）"; fi
}
assert_count() {
  local desc="$1" pat="$2" want="$3" n
  n=$(grep -cF -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq "$want" ]; then ok "$desc（$n 次）"; else bad "$desc（${n:-0} 次，期望 $want；pattern: $pat）"; fi
}
assert_absent() {
  local desc="$1" pat="$2" n
  n=$(grep -cF -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq 0 ]; then ok "$desc"; else bad "$desc（出现 $n 次；pattern: $pat）"; fi
}
assert_absent_regex() {
  local desc="$1" pat="$2" n
  n=$(grep -cE -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq 0 ]; then ok "$desc"; else bad "$desc（出现 $n 次；regex: $pat）"; fi
}
assert_stack_has() {
  local desc="$1" json="$2" elem="$3"
  case "$json" in
    *"\"$elem\""*) ok "$desc" ;;
    *) bad "$desc（stack=$json）" ;;
  esac
}
assert_stack_lacks() {
  local desc="$1" json="$2" elem="$3"
  case "$json" in
    *"\"$elem\""*) bad "$desc（stack=$json）" ;;
    *) ok "$desc" ;;
  esac
}
assert_stack_eq() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc（实际=$got 期望=$want）"; fi
}
assert_num_eq() {
  local desc="$1" got="$2" want="$3"
  if [ "${got:-x}" = "$want" ]; then ok "$desc（$got）"; else bad "$desc（实际=${got:-空} 期望=$want）"; fi
}
stack_line() {
  grep -F "[navtest] $1 stack=" "$LOG_FILE" 2>/dev/null | tail -1 | sed 's/.* stack=//'
}
