export const DEFAULT_MODEL = "Xenova/bert-base-NER";

export const APPROVED_MODELS = Object.freeze({
  "Xenova/bert-base-NER": Object.freeze({
    label: "BERT English NER",
    revision: "24c7e5aba9ae350923357a6f0b92571be34037ec",
    approximateSize: 105_000_000,
    files: Object.freeze({
      "config.json": "a73a2eccc921bbdea95a94b49a157d3694b5c2abbae7a6f3000e14404a9c31a8",
      "tokenizer.json": "343989712a36cd8b253efeaf8baf6a08b9d2583f78e395e83832e8ee9f8d8ee1",
      "tokenizer_config.json": "5be1a180e9badb4811a6c31502d70fb35a085af5457982937419c42d7530bae6",
      "onnx/model_quantized.onnx": "caaee70a5518ec7f9e46e5308fcc9263a8c227703a9ce46cf61c69a552349648",
    }),
  }),
  "Xenova/distilbert-base-multilingual-cased-ner-hrl": Object.freeze({
    label: "DistilBERT Multilingual NER",
    revision: "c2a4dbf593c57f47004c5bc2d3770d311aee9c43",
    approximateSize: 132_000_000,
    files: Object.freeze({
      "config.json": "38847be4dc6699b1218a749ed69f888c2ccc7b4deba98e3c4a1cac8cb34d54c8",
      "tokenizer.json": "bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088",
      "tokenizer_config.json": "2d61ce6c7646881e0e7ef08e3b5dd655a19553ab85c41b1a3c27090a63ff6f49",
      "onnx/model_quantized.onnx": "24a0b98f4dd4cd92842f5a541272f86f760225a64a29928eddef14bdb2edb986",
    }),
  }),
});

export function getApprovedModel(modelId) {
  return APPROVED_MODELS[modelId] || null;
}

export function isValidHuggingFaceModelId(modelId) {
  return typeof modelId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(modelId);
}

export function modelFileUrl(modelId, revision, filename) {
  return `https://huggingface.co/${modelId}/resolve/${revision}/${filename}`;
}
