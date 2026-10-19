import { useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { launchImageLibrary } from 'react-native-image-picker';
import { compress } from 'react-native-media-transformer';

export default function App() {
  const [inputUri, setInputUri] = useState<string | null>(null);
  const [status, setStatus] = useState('Choose a video to compress');
  const [outputUri, setOutputUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handlePickVideo = async () => {
    try {
      setStatus('Picking video...');
      const result = await launchImageLibrary({
        mediaType: 'video',
        selectionLimit: 1,
      });

      const selectedAsset = result.assets?.[0];
      if (!selectedAsset?.uri) {
        setStatus('No video selected');
        return;
      }

      setInputUri(selectedAsset.uri);
      setStatus(`Selected: ${selectedAsset.fileName ?? 'video'}`);
      setOutputUri(null);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Failed to pick video.'
      );
    }
  };

  const handleCompress = async () => {
    if (!inputUri) {
      setStatus('Please choose a video first.');
      return;
    }

    try {
      setIsLoading(true);
      setStatus('Compressing...');
      setOutputUri(null);

      const result = await compress(inputUri, {
        maxHeight: 720,
        bitrate: 1500000,
        outputFileName: 'compressed-output.mp4',
      });

      setStatus('Compression complete');
      setOutputUri(result);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : 'Compression failed unexpectedly.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!outputUri) {
      setStatus('Compress a video before saving it.');
      return;
    }

    try {
      setIsSaving(true);
      setStatus('Saving to gallery...');

      if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
        const permission =
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
        const granted = await PermissionsAndroid.request(permission);
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setStatus('Storage permission is required to save the video.');
          return;
        }
      }

      const fileUri = outputUri.startsWith('file://')
        ? outputUri
        : `file://${outputUri}`;
      await CameraRoll.saveAsset(fileUri, {
        type: 'video',
        album: 'MediaTransformer',
      });
      setStatus('Video saved to gallery');
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Failed to save video.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>MediaTransformer</Text>

      <View style={styles.buttonContainer}>
        <Button
          title="Choose video"
          onPress={handlePickVideo}
          disabled={isLoading || isSaving}
        />
      </View>

      <View style={styles.buttonContainer}>
        <Button
          title={isLoading ? 'Compressing...' : 'Compress video'}
          onPress={handleCompress}
          disabled={!inputUri || isLoading || isSaving}
        />
      </View>

      {outputUri ? (
        <View style={styles.buttonContainer}>
          <Button
            title={isSaving ? 'Saving...' : 'Save to gallery'}
            onPress={handleSave}
            disabled={isLoading || isSaving}
          />
        </View>
      ) : null}

      {isLoading || isSaving ? (
        <ActivityIndicator style={styles.loader} />
      ) : null}

      <Text style={styles.status}>{status}</Text>
      {inputUri ? <Text style={styles.path}>Selected: {inputUri}</Text> : null}
      {outputUri ? (
        <Text style={styles.result}>Output: {outputUri}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 24,
  },
  buttonContainer: {
    marginBottom: 16,
  },
  loader: {
    marginBottom: 16,
  },
  status: {
    fontSize: 16,
    marginBottom: 8,
  },
  path: {
    fontSize: 12,
    color: '#374151',
    marginBottom: 8,
  },
  result: {
    fontSize: 14,
    color: '#166534',
    flexShrink: 1,
  },
});
