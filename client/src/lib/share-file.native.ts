// Hands a text file to the phone's share sheet as a real file (a name with an extension), so it
// can be saved to Files, sent with AirDrop or attached, instead of being pasted as text.
// The plain copy lives in the cache folder only until the share sheet closes.

import { File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';

export async function shareTextFile(name: string, text: string, mimeType: string, uti: string): Promise<void> {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(text);
  try {
    await shareAsync(file.uri, { mimeType, UTI: uti, dialogTitle: name });
  } finally {
    try {
      file.delete();
    } catch {
      // Already gone.
    }
  }
}
