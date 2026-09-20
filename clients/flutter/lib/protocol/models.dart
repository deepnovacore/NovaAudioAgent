import 'dart:typed_data';

final class PlaybackIdentity {
  const PlaybackIdentity(this.utteranceId, this.epoch);
  final String utteranceId;
  final int epoch;
  Map<String, Object> get fields => {
    'utterance_id': utteranceId,
    'generation_epoch': epoch,
  };
  @override
  bool operator ==(Object other) =>
      other is PlaybackIdentity &&
      other.utteranceId == utteranceId &&
      other.epoch == epoch;
  @override
  int get hashCode => Object.hash(utteranceId, epoch);
}

final class AudioFrame {
  const AudioFrame(this.identity, this.sequence, this.pcm);
  final PlaybackIdentity identity;
  final int sequence;
  final Uint8List pcm;
}

final class Ready {
  const Ready({
    required this.instance,
    required this.connection,
    required this.editableInput,
    required this.aoqChat,
    required this.aoqRuntime,
    this.pipeline,
  });
  final String instance, connection;
  final String? pipeline;
  final bool editableInput, aoqChat, aoqRuntime;
}
