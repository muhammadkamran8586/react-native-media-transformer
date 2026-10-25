import { PermissionsAndroid, Platform } from 'react-native';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { launchImageLibrary } from 'react-native-image-picker';

export async function chooseVideo(): Promise<{
  uri: string;
  name: string;
} | null> {
  const result = await launchImageLibrary({
    mediaType: 'video',
    selectionLimit: 1,
  });
  if (result.errorCode)
    throw new Error(result.errorMessage ?? result.errorCode);
  const asset = result.assets?.[0];
  return asset?.uri
    ? { uri: asset.uri, name: asset.fileName ?? 'video' }
    : null;
}

export async function saveVideo(path: string): Promise<void> {
  if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    if (
      (await PermissionsAndroid.request(permission)) !==
      PermissionsAndroid.RESULTS.GRANTED
    )
      throw new Error('Storage permission is required to save the video.');
  }
  await CameraRoll.saveAsset(
    path.startsWith('file://') ? path : `file://${path}`,
    { type: 'video', album: 'MediaTransformer' }
  );
}
