import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

/// Colours follow the original SwiftUI client: ink background, grouped cells
/// one step lighter, mint only for actions and selection.
abstract final class Nova {
  static const ink = Color(0xff090e14),
      inkTop = Color(0xff111a20),
      cell = Color(0xff161c22),
      cellPressed = Color(0xff1f262d),
      sheet = Color(0xff1c1c1e),
      sheetCell = Color(0xff2c2c2e),
      separator = Color(0x1fffffff),
      text = Color(0xffeef1f3),
      secondary = Color(0x99ebebf5),
      tertiary = Color(0x4debebf5),
      mint = Color(0xff94ebd9),
      amber = Color(0xffe9b95f),
      red = Color(0xffe0605f);
}

const novaBackground = BoxDecoration(
  gradient: LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment(0, -.2),
    colors: [Nova.inkTop, Nova.ink],
  ),
);

ThemeData novaTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Nova.mint,
    brightness: Brightness.dark,
    primary: Nova.mint,
    onPrimary: Nova.ink,
    surface: Nova.ink,
    onSurface: Nova.text,
    error: Nova.red,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: Colors.transparent,
    canvasColor: Nova.ink,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.white.withValues(alpha: .04),
    dividerColor: Nova.separator,
    textTheme: Typography.whiteCupertino.apply(
      bodyColor: Nova.text,
      displayColor: Nova.text,
    ),
    cupertinoOverrideTheme: const CupertinoThemeData(
      brightness: Brightness.dark,
      primaryColor: Nova.mint,
      scaffoldBackgroundColor: Nova.ink,
      barBackgroundColor: Color(0xe6090e14),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleSpacing: 20,
      toolbarHeight: 60,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Nova.sheet,
      surfaceTintColor: Colors.transparent,
      showDragHandle: false,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Nova.sheetCell,
      contentTextStyle: const TextStyle(color: Nova.text, fontSize: 15),
      actionTextColor: Nova.mint,
      elevation: 0,
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Nova.sheet,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Nova.sheetCell,
      hintStyle: const TextStyle(color: Nova.tertiary),
      labelStyle: const TextStyle(color: Nova.secondary),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide.none,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: Nova.mint,
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Nova.mint,
        foregroundColor: Nova.ink,
        disabledBackgroundColor: Nova.mint.withValues(alpha: .18),
        disabledForegroundColor: Nova.mint.withValues(alpha: .4),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: Nova.mint,
      foregroundColor: Nova.ink,
      elevation: 0,
      highlightElevation: 0,
      shape: CircleBorder(),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Nova.mint),
  );
}
