export async function chooseVideo(): Promise<{
  uri: string;
  name: string;
} | null> {
  throw new Error(
    'Open the Android or iOS example app to choose and process videos.'
  );
}

export async function saveVideo(_path: string): Promise<void> {
  throw new Error(
    'Photo library saving requires the Android or iOS example app.'
  );
}
