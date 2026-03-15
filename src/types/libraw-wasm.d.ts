declare module 'libraw-wasm' {
  export default class LibRaw {
    constructor()
    open(buffer: Uint8Array, settings?: Record<string, unknown>): Promise<void>
    metadata(fullOutput?: boolean): Promise<Record<string, unknown>>
    imageData(): Promise<unknown>
  }
}
