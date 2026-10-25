import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

if (typeof document !== 'undefined') {
  AppRegistry.runApplication(appName, {
    rootTag: document.getElementById('root'),
  });
}

// Available through the Hermes inspector for repeatable native bridge checks.
if (__DEV__) {
  global.runMediaTransformerChecks = (inputUri) =>
    import('./src/nativeChecks').then(({ runNativeChecks }) =>
      runNativeChecks(inputUri)
    );
}
