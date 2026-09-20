import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../protocol/pairing.dart';
import 'strings.dart';

class PairingScanner extends StatefulWidget {
  const PairingScanner({super.key, this.language = 'en'});
  final String language;
  @override
  State<PairingScanner> createState() => _PairingScannerState();
}

class _PairingScannerState extends State<PairingScanner>
    with WidgetsBindingObserver {
  final _controller = MobileScannerController(autoStart: false);
  bool _delivered = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller.start().catchError((Object error) {
      if (mounted) setState(() => _error = error.toString());
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused && mounted && !_delivered) {
      _delivered = true;
      Navigator.of(context).pop();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(tr(widget.language, 'Scan Nova QR code'))),
    body: Stack(
      children: [
        MobileScanner(
          controller: _controller,
          onDetect: (capture) {
            if (_delivered) return;
            for (final barcode in capture.barcodes) {
              if (barcode.rawValue == null) continue;
              try {
                final invitation = PairingCode.parse(barcode.rawValue!);
                _delivered = true;
                Navigator.of(context).pop(invitation);
                return;
              } on FormatException catch (error) {
                setState(() => _error = error.message);
              }
            }
          },
        ),
        if (_error != null)
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(_error!),
                ),
              ),
            ),
          ),
      ],
    ),
  );
}
