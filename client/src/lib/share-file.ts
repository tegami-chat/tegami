// The browser downloads the file itself (settings/talk.tsx); only the phone apps share a file here.
export async function shareTextFile(_name: string, _text: string, _mimeType: string, _uti: string): Promise<void> {
  throw new Error('shareTextFile is for the phone apps');
}
