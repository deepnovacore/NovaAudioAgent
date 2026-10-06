import 'dart:math' as math;
import 'package:flutter/material.dart';

/// Port of the native client's deterministic 520-particle NovaStarfield.
class VoiceOrb extends StatefulWidget {
  const VoiceOrb({super.key, required this.listening, required this.level});
  final bool listening;
  final double level;
  @override
  State<VoiceOrb> createState() => _VoiceOrbState();
}

class _VoiceOrbState extends State<VoiceOrb>
    with SingleTickerProviderStateMixin {
  late final _animation = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 120),
  );
  bool _reduce = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduce = MediaQuery.disableAnimationsOf(context);
    if (_reduce) {
      _animation.stop();
    } else {
      _animation.repeat();
    }
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 238,
    height: 238,
    child: AnimatedBuilder(
      animation: _animation,
      builder: (_, _) => CustomPaint(
        painter: _Starfield(
          _reduce ? 0 : _animation.value * 120,
          _reduce || !widget.listening ? 0 : (widget.level * 1.4).clamp(0, 1),
        ),
      ),
    ),
  );
}

class _Starfield extends CustomPainter {
  _Starfield(this.time, this.amplitude);
  final double time, amplitude;
  static const mint = Color.fromRGBO(148, 235, 217, 1);
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    canvas.drawCircle(
      center,
      119,
      Paint()
        ..shader = RadialGradient(
          colors: [
            mint.withValues(alpha: 0.20),
            const Color.fromRGBO(20, 31, 61, 0.6),
            Colors.transparent,
          ],
        ).createShader(Rect.fromCircle(center: center, radius: 119)),
    );
    canvas.drawCircle(
      center,
      113,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.5
        ..color = mint.withValues(alpha: 0.09),
    );
    for (var index = 0; index < 520; index++) {
      final seed = index.toDouble(), fraction = (index * 0.61803398875) % 1;
      final radius =
          (12 + math.sqrt(fraction) * 94) *
          (1 + amplitude * 0.035 * math.sin(time * 1.8 + seed * 0.13));
      final angle = seed * 2.399963 + time * (0.055 + fraction * 0.045),
          depth = math.sin(seed * 1.73);
      final point =
          center +
          Offset(
            math.cos(angle) * radius,
            math.sin(angle) * radius * (0.78 + depth * 0.16),
          );
      final width =
          (index % 29 == 0
              ? 2.6
              : index % 7 == 0
              ? 1.6
              : 0.85) *
          (1 + amplitude * 0.12);
      final opacity =
          ((0.3 + 0.5 * (1 - fraction)) *
                      (0.65 + 0.35 * math.sin(time * 0.7 + seed)) +
                  amplitude * 0.10)
              .clamp(0.0, 1.0);
      final color = index % 7 == 0
          ? const Color.fromRGBO(255, 212, 148, 1)
          : index % 3 == 0
          ? Colors.white
          : mint;
      final paint = Paint()
        ..blendMode = BlendMode.plus
        ..color = color.withValues(alpha: opacity);
      canvas.drawCircle(point, width / 2, paint);
      if (index % 29 == 0) {
        canvas.drawCircle(
          point,
          width / 2 + 2,
          paint..color = color.withValues(alpha: opacity * 0.10),
        );
      }
    }
  }

  @override
  bool shouldRepaint(_Starfield old) =>
      old.time != time || old.amplitude != amplitude;
}
