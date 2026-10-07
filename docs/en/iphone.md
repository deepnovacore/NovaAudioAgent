# Use Nova on iPhone

Talk to Nova, approve operations and receive task results on your iPhone. Models, memory and coding tasks run on your computer.

## Prepare

Have Nova working on the computer, connect both devices to the same Tailscale network, and install the iPhone client. Allow microphone access when needed. Keep the computer online.

## Pair

On macOS, right-click the orb and choose “连接 iPhone…”:

1. Enable the phone connection.
2. Follow the secure-connection prompts.
3. Scan the QR code on your iPhone and confirm the connection details.

Codes are single-use; refreshing invalidates the previous code. You can revoke paired devices on the computer. For a separately hosted service, see [remote deployment](deployment/remote-server.md).

## Talk or type

Realtime conversation is the default. If the computer uses cascaded speech and supports editable input, text chat is also available. Type a message or dictate, edit and send a draft.

Switching to text pauses live audio. Switching back cancels ongoing dictation but preserves the text draft. Changing the phone's view does not change the computer's voice pipeline.

## Tasks and permissions

Tasks execute on the computer. When approval is needed, the phone shows the operation and the available decisions. “Allow” applies only to that request; “Allow for this session”, when offered, keeps the grant for the rest of the session, so choose it deliberately.

Ending a call does not cancel a task; request cancellation explicitly. After reconnecting, use the returned task state to check progress instead of repeating an approved operation.

## Limits

The message list may not survive an app restart. Phone cameras, screen sharing and background wake words are not supported. Network conditions, computer sleep and audio permissions affect calls. Reconnection clears stale audio and approval controls; approvals are not replayed automatically.

The supported iPhone app is the native client in `clients/ios/Nova`. The Flutter client in `clients/flutter` (a five-tab workbench for Todos, Ideas, Goals, Feeds and Profile) is an in-progress port; it is not part of the 0.3.0 release, and Android, physical-device sync and live audio are not yet accepted.

For client integration, see the [protocol reference](protocols/client-v1.md).
