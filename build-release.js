// Builds a signed release APK from an obfuscated copy of www/, leaving the readable
// source in www/ untouched for future editing.
//
// What this does and does NOT protect:
// - JS in app.js / native-bridge.js / i18n.js is minified and has identifiers renamed to
//   hex, strings encoded/split. This is real friction for casual inspection (unzip the
//   APK, open a .js file) but NOT true secrecy - a WebView must ship JS the device can
//   execute, so a determined attacker with deobfuscation tools can still recover the
//   logic. There is no way to make client-side JS in a WebView app fully unreadable.
// - The native Android code (GeoCamNativePlugin.java, MainActivity.java) is separately
//   obfuscated by R8/ProGuard as part of the normal Android release build (already
//   configured in android/app/build.gradle + proguard-rules.pro).
//
// Usage: node build-release.js
// Output: android/app/build/outputs/apk/release/app-release.apk

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const SRC_WWW = path.join(ROOT, 'www');
const DIST_WWW = path.join(ROOT, 'www-release');
const CONFIG_PATH = path.join(ROOT, 'capacitor.config.json');
const JS_FILES_TO_OBFUSCATE = ['app.js', 'native-bridge.js', 'i18n.js'];

// Moderate profile: strong identifier/string obfuscation without control-flow-flattening
// or dead-code-injection, which noticeably slow down real-time code (GPS ticks, camera
// frame handling) on weaker Android phones - not worth the tradeoff for this app.
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  disableConsoleOutput: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 8,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  numbersToExpressions: true,
  simplify: true,
};

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

function obfuscateFile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS);
  fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8');
}

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env, windowsHide: true });
}

const originalConfigRaw = fs.readFileSync(CONFIG_PATH, 'utf8');

try {
  console.log('1) Copying www/ -> www-release/');
  copyDir(SRC_WWW, DIST_WWW);

  console.log('2) Obfuscating app JS (app.js, native-bridge.js, i18n.js)');
  for (const f of JS_FILES_TO_OBFUSCATE) obfuscateFile(path.join(DIST_WWW, f));

  console.log('3) Pointing capacitor.config.json at www-release/ for this build');
  const config = JSON.parse(originalConfigRaw);
  config.webDir = 'www-release';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  run('npx cap sync android', ROOT);
  const androidDir = path.join(ROOT, 'android');
  const gradlewPath = path.join(androidDir, 'gradlew.bat');
  run(`"${gradlewPath}" assembleRelease --console=plain`, androidDir);

  console.log('\nDone. Release APK: android/app/build/outputs/apk/release/app-release.apk');
} finally {
  console.log('\n4) Restoring capacitor.config.json to www/ (dev source stays editable)');
  fs.writeFileSync(CONFIG_PATH, originalConfigRaw);
  run('npx cap sync android', ROOT);
}
