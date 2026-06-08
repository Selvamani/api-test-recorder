async function makeSeekableWebM(chunks) {
  const rawBlob = new Blob(chunks, { type: "video/webm" });
  try {
    if (!window.EBML) throw new Error("EBML not loaded");

    const decoder = new EBML.Decoder();
    const reader  = new EBML.Reader();
    reader.logging = false;

    const arrayBuf = await rawBlob.arrayBuffer();
    const elems = decoder.decode(arrayBuf);
    elems.forEach(e => reader.read(e));
    reader.stop();

    const refinedMetadata = EBML.tools.makeMetadataSeekable(
      reader.metadatas, reader.duration, reader.cues
    );
    const body = arrayBuf.slice(reader.metadataSize);
    const fixedBlob = new Blob([refinedMetadata, body], { type: "video/webm" });
    console.log("[API-REC] WebM seekable — duration:", reader.duration, "ms, size:", fixedBlob.size);
    return fixedBlob;
  } catch (err) {
    console.warn("[API-REC] WebM fix failed, using raw:", err.message);
    return rawBlob;
  }
}
