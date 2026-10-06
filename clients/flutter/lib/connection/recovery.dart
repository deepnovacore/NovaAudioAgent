final class Recovery {
  int _attempts = 0;
  int? _readyAt;
  void markReady(int nowMs) => _readyAt = nowMs;
  Duration? nextDelay(int nowMs) {
    if (_readyAt != null && nowMs - _readyAt! >= 30000) _attempts = 0;
    _readyAt = null;
    if (_attempts >= 3) return null;
    return Duration(seconds: 1 << _attempts++);
  }
}
