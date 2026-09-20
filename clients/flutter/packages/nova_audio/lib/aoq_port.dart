abstract interface class AoqPort {
  Future<void> startAoq(
    Map<String, Object?> payload, {
    required int generation,
    required bool runtime,
  });
  Future<void> aoqCommand(Map<String, dynamic> event);
  Future<void> aoqClear();
}
