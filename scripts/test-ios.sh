#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/media-transformer-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/mac" "$test_dir/ios"
mac_target="$(uname -m)-apple-macosx13.0"

# Exercise the production implementation with Nitro's actual Promise. The bridge
# shim avoids requiring CocoaPods/React Native to run AVFoundation regression tests.
promise_source=node_modules/react-native-nitro-modules/ios/core/Promise.swift
cat > "$test_dir/RuntimeError.swift" <<'EOF'
public enum RuntimeError: Error {
    case error(withMessage: String)
}
EOF

xcrun swiftc -swift-version 5 -target "$mac_target" -module-cache-path "$test_dir/modules" \
  -emit-module -emit-library -module-name NitroModules \
  "$promise_source" "$test_dir/RuntimeError.swift" \
  -o "$test_dir/mac/libNitroModules.dylib" \
  -emit-module-path "$test_dir/mac/NitroModules.swiftmodule"

ios_sdk=$(xcrun --sdk iphoneos --show-sdk-path)
xcrun swiftc -swift-version 5 -module-cache-path "$test_dir/modules" \
  -sdk "$ios_sdk" -target arm64-apple-ios15.1 \
  -emit-module -module-name NitroModules \
  "$promise_source" "$test_dir/RuntimeError.swift" \
  -emit-module-path "$test_dir/ios/NitroModules.swiftmodule"
xcrun swiftc -swift-version 5 -module-cache-path "$test_dir/modules" \
  -sdk "$ios_sdk" -target arm64-apple-ios15.1 -I "$test_dir/ios" \
  -typecheck tests/ios/Bridge.swift ios/MediaTransformer.swift
echo 'PASS: iOS 15.1 SDK typecheck (bridge shim)'

xcrun swiftc -swift-version 5 -O -module-cache-path "$test_dir/modules" \
  -target "$mac_target" -I "$test_dir/mac" -L "$test_dir/mac" \
  -lNitroModules -Xlinker -rpath -Xlinker "$test_dir/mac" \
  tests/ios/Bridge.swift ios/MediaTransformer.swift tests/ios/CompressionTests.swift \
  -o "$test_dir/compression-tests"
CFFIXED_USER_HOME="$test_dir" "$test_dir/compression-tests" "$test_dir"
