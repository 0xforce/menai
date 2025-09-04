declare module 'lz-string' {
  export interface LZStringStatic {
    compressToUTF16(input: string): string;
    decompressFromUTF16(compressed: string): string | null;
  }

  const LZString: LZStringStatic;
  export default LZString;

  export function compressToUTF16(input: string): string;
  export function decompressFromUTF16(compressed: string): string | null;
}


