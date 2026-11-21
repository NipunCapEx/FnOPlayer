import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:foplayer/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'FnO Players starts safely when Firebase is not configured',
    (tester) async {
      // CI intentionally omits google-services.json. The app must fail closed
      // with its setup guidance rather than entering an unauthenticated demo
      // dashboard or attempting production authentication/data access.
      await app.main();
      await tester.pumpAndSettle();

      expect(find.text('Firebase setup required'), findsOneWidget);
      expect(
        find.textContaining(
          'needs its own Firebase Android app and Google sign-in configuration',
        ),
        findsOneWidget,
      );
      expect(find.text('Continue with Google'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
