import { useState } from 'react';
import {
  ActivityIndicator,
  Button,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { chooseVideo, saveVideo } from './mediaLibrary';
import {
  createThumbnail,
  getVideoMetadata,
  useVideoCompressor,
} from 'react-native-media-transformer';
import type {
  CompressOptions,
  QualityPreset,
  ThumbnailResult,
  VideoMetadata,
} from 'react-native-media-transformer';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const fileUri = (path: string) =>
  path.startsWith('file://') ? path : `file://${path}`;
const summary = (info: VideoMetadata) =>
  `${info.width} × ${info.height} · ${info.duration.toFixed(1)}s · ${(info.size / 1024 / 1024).toFixed(2)} MB · ${info.frameRate.toFixed(1)} fps`;
const numericFields = [
  ['maxWidth', 'Maximum width (px)'],
  ['maxHeight', 'Maximum height (px)'],
  ['bitrate', 'Video bitrate (bits/s)'],
  ['maxFrameRate', 'Maximum frame rate'],
  ['startTime', 'Trim start (seconds)'],
  ['endTime', 'Trim end (seconds)'],
  ['audioBitrate', 'Audio bitrate (bits/s)'],
  ['audioSampleRate', 'Audio sample rate (Hz)'],
  ['audioChannels', 'Audio channels (1 or 2)'],
  ['progressInterval', 'Progress interval (ms)'],
] as const;
type NumericField = (typeof numericFields)[number][0];

export default function App() {
  const {
    compressVideo,
    cancel,
    reset,
    progressPercent,
    isCompressing,
    outputPath,
  } = useVideoCompressor();
  const [inputUri, setInputUri] = useState<string | null>(null);
  const [status, setStatus] = useState('Choose a video to get started.');
  const [inputInfo, setInputInfo] = useState<VideoMetadata | null>(null);
  const [outputInfo, setOutputInfo] = useState<VideoMetadata | null>(null);
  const [thumbnail, setThumbnail] = useState<ThumbnailResult | null>(null);
  const [quality, setQuality] = useState<QualityPreset>('medium');
  const [codec, setCodec] = useState<'h264' | 'hevc'>('h264');
  const [mute, setMute] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [optimize, setOptimize] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [values, setValues] = useState<Partial<Record<NumericField, string>>>(
    {}
  );
  const [filename, setFilename] = useState('');
  const [thumbnailTime, setThumbnailTime] = useState('0');
  const [working, setWorking] = useState(false);
  const busy = working || isCompressing;

  const handlePick = async () => {
    setWorking(true);
    try {
      const asset = await chooseVideo();
      if (!asset) {
        setStatus('No video selected.');
        return;
      }
      await reset();
      setInputUri(asset.uri);
      setInputInfo(null);
      setOutputInfo(null);
      setThumbnail(null);
      setStatus(`Selected ${asset.name}`);
      setInputInfo(await getVideoMetadata(asset.uri));
    } catch (error) {
      setStatus(message(error));
    } finally {
      setWorking(false);
    }
  };

  const handleCompress = async () => {
    if (!inputUri) return;
    try {
      setOutputInfo(null);
      const options: CompressOptions = {
        quality,
        codec,
        mute,
        overwrite,
        optimizeForNetworkUse: optimize,
      };
      if (advanced) {
        for (const [key] of numericFields) {
          const value = values[key]?.trim();
          if (value) options[key] = Number(value);
        }
        if (filename.trim()) options.outputFileName = filename.trim();
      }
      setStatus('Compressing video…');
      const path = await compressVideo(inputUri, options);
      setWorking(true);
      const info = await getVideoMetadata(path);
      setOutputInfo(info);
      const saved =
        inputInfo && inputInfo.size > 0
          ? (1 - info.size / inputInfo.size) * 100
          : null;
      setStatus(
        saved !== null && saved >= 0
          ? `Complete · ${saved.toFixed(1)}% smaller`
          : 'Complete. Output size depends on the source and chosen settings.'
      );
    } catch (error) {
      setStatus(message(error));
    } finally {
      setWorking(false);
    }
  };

  const handleThumbnail = async () => {
    if (!inputUri) return;
    setWorking(true);
    try {
      setThumbnail(
        await createThumbnail(inputUri, {
          time: Number(thumbnailTime),
          maxWidth: 480,
          maxHeight: 320,
          quality: 0.85,
        })
      );
      setStatus('Thumbnail ready.');
    } catch (error) {
      setStatus(message(error));
    } finally {
      setWorking(false);
    }
  };

  const handleSave = async () => {
    if (!outputPath) return;
    setWorking(true);
    try {
      await saveVideo(outputPath);
      setStatus('Saved to your photo library.');
    } catch (error) {
      setStatus(message(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.eyebrow}>VIDEO TOOLKIT</Text>
      <Text style={styles.title}>Media Transformer</Text>
      <Text style={styles.subtitle}>
        Resize, trim, compress, and create thumbnails on your device.
      </Text>
      <View style={styles.card}>
        <Button title="Choose video" onPress={handlePick} disabled={busy} />
        {inputInfo ? (
          <Text style={styles.detail}>
            {summary(inputInfo)}
            {inputInfo.hasAudio ? ' · Audio' : ' · Silent'}
          </Text>
        ) : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>Quality</Text>
        <View style={styles.choices}>
          {(['low', 'medium', 'high'] as const).map((preset) => (
            <Pressable
              key={preset}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{
                checked: preset === quality,
                disabled: busy,
              }}
              onPress={() => setQuality(preset)}
              style={[styles.choice, quality === preset && styles.selected]}
            >
              <Text
                style={[
                  styles.choiceText,
                  quality === preset && styles.selectedText,
                ]}
              >
                {preset.charAt(0).toUpperCase() + preset.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.detail}>
          Low: smaller files · Medium: balanced · High: more detail
        </Text>
        <Text style={styles.heading}>Format</Text>
        <View style={styles.choices}>
          {(['h264', 'hevc'] as const).map((format) => (
            <Pressable
              key={format}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ checked: format === codec, disabled: busy }}
              onPress={() => setCodec(format)}
              style={[styles.choice, codec === format && styles.selected]}
            >
              <Text
                style={[
                  styles.choiceText,
                  codec === format && styles.selectedText,
                ]}
              >
                {format === 'h264' ? 'H.264' : 'HEVC'}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.detail}>
          HEVC requires a supported device. H.264 has wider playback support.
        </Text>
        <View style={styles.row}>
          <Text style={styles.label}>Remove audio</Text>
          <Switch
            value={mute}
            onValueChange={setMute}
            disabled={busy}
            accessibilityLabel="Remove audio"
          />
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Prepare for streaming</Text>
          <Switch
            value={optimize}
            onValueChange={setOptimize}
            disabled={busy}
            accessibilityLabel="Prepare for streaming"
          />
        </View>
        <Button
          title={advanced ? 'Hide advanced options' : 'Show advanced options'}
          onPress={() => setAdvanced(!advanced)}
          disabled={busy}
        />
        {advanced ? (
          <View>
            <Text style={styles.detail}>
              Blank fields use the quality preset or encoder default. Dimensions
              keep the aspect ratio and never enlarge the source.
            </Text>
            {numericFields.map(([key, label]) => (
              <View key={key} style={styles.field}>
                <Text style={styles.label}>{label}</Text>
                <TextInput
                  accessibilityLabel={label}
                  style={styles.input}
                  editable={!busy && !(mute && key.startsWith('audio'))}
                  value={values[key] ?? ''}
                  onChangeText={(value) =>
                    setValues((current) => ({ ...current, [key]: value }))
                  }
                  placeholder="Automatic"
                  placeholderTextColor="#64748b"
                  keyboardType="decimal-pad"
                />
              </View>
            ))}
            <Text style={styles.label}>Output filename</Text>
            <TextInput
              accessibilityLabel="Output filename"
              style={styles.input}
              editable={!busy}
              value={filename}
              onChangeText={setFilename}
              autoCapitalize="none"
              placeholder="Automatic unique name (.mp4)"
              placeholderTextColor="#64748b"
            />
            <View style={styles.row}>
              <Text style={styles.label}>Replace matching output</Text>
              <Switch
                value={overwrite}
                onValueChange={setOverwrite}
                disabled={busy}
                accessibilityLabel="Replace matching output"
              />
            </View>
          </View>
        ) : null}
      </View>
      <View style={styles.card}>
        <Button
          title={
            isCompressing
              ? `Compressing · ${progressPercent}%`
              : 'Compress video'
          }
          onPress={handleCompress}
          disabled={!inputUri || busy}
        />
        {isCompressing ? (
          <View style={styles.field}>
            <Button
              title="Cancel compression"
              onPress={() => {
                cancel().catch((error) => setStatus(message(error)));
              }}
              color="#b91c1c"
            />
          </View>
        ) : null}
        {busy ? <ActivityIndicator style={styles.field} /> : null}
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
        {outputInfo ? (
          <Text style={styles.detail}>{summary(outputInfo)}</Text>
        ) : null}
        {outputPath ? (
          <>
            <Text selectable style={styles.path}>
              {outputPath}
            </Text>
            <Button
              title="Save to photo library"
              onPress={handleSave}
              disabled={busy}
            />
          </>
        ) : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>Thumbnail</Text>
        <Text style={styles.label}>Time in seconds</Text>
        <TextInput
          accessibilityLabel="Thumbnail time in seconds"
          style={styles.input}
          editable={!busy}
          value={thumbnailTime}
          onChangeText={setThumbnailTime}
          keyboardType="decimal-pad"
        />
        <Button
          title="Create thumbnail"
          onPress={handleThumbnail}
          disabled={!inputUri || busy}
        />
        {thumbnail ? (
          <Image
            accessibilityLabel="Video thumbnail"
            source={{ uri: fileUri(thumbnail.path) }}
            style={styles.thumbnail}
            resizeMode="contain"
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9' },
  container: {
    paddingHorizontal: 20,
    paddingTop: 52,
    paddingBottom: 48,
    gap: 18,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    color: '#2563eb',
  },
  title: { fontSize: 30, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 16, lineHeight: 24, color: '#475569' },
  card: { padding: 18, borderRadius: 16, backgroundColor: '#fff', gap: 12 },
  heading: { fontSize: 18, fontWeight: '600', color: '#0f172a' },
  choices: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  choice: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#e2e8f0',
  },
  selected: { backgroundColor: '#2563eb' },
  choiceText: { color: '#0f172a', fontWeight: '600' },
  selectedText: { color: '#fff' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  label: { fontSize: 14, color: '#334155', flexShrink: 1 },
  field: { marginVertical: 8, gap: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 12,
    color: '#0f172a',
    minHeight: 48,
  },
  detail: { color: '#64748b', fontSize: 13, lineHeight: 20 },
  status: { color: '#0f172a', fontSize: 15, lineHeight: 22 },
  path: { fontSize: 11, color: '#475569' },
  thumbnail: {
    width: '100%',
    height: 220,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
});
