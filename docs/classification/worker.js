import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

env.localModelPath = './model/';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.backends.onnx.device = 'wasm';

let classifierPromise = null;
let processingQueue = Promise.resolve();
let currentDevice = 'wasm';

function splitIntoChunks(text, max) {
  if (max < 1) {
    throw new Error("`max` must be at least 1.");
  }

  const chunks = [];
  const totalLength = text.length;
  let cursor = 0;

  while (cursor < totalLength) {
    let limit = Math.min(cursor + max, totalLength);

    if (limit === totalLength) {
      chunks.push({
        start: cursor,
        end: totalLength,
        text: text.slice(cursor, totalLength),
      });
      break;
    }

    let breakPos = text.lastIndexOf("\n", limit - 1);
    if (breakPos >= cursor) {
      limit = breakPos + 1;
    } else {
      breakPos = text.lastIndexOf(" ", limit - 1);
      if (breakPos >= cursor) {
        limit = breakPos + 1;
      }
    }

    if (limit <= cursor) {
      limit = Math.min(cursor + max, totalLength);
    }

    chunks.push({
      start: cursor,
      end: limit,
      text: text.slice(cursor, limit),
    });

    cursor = limit;
  }

  return chunks;
}

function normalizeTokenWord(word) {
  if (!word) {
    return "";
  }
  return word.replace(/Ġ/g, " ").replace(/▁/g, " ").replace(/Ċ/g, "\n");
}

function attachOffsetsFromPredictions(tokens, text) {
  if (!Array.isArray(tokens) || !tokens.length) {
    return [];
  }

  let cursor = 0;

  return tokens.map((token) => {
    if (
      typeof token.start === "number" &&
      typeof token.end === "number" &&
      token.start !== null &&
      token.end !== null &&
      !Number.isNaN(token.start) &&
      !Number.isNaN(token.end)
    ) {
      cursor = Math.max(cursor, token.end);
      return token;
    }

    const decoded = normalizeTokenWord(token.word || "").trim();
    if (!decoded) {
      return {
        ...token,
        start: cursor,
        end: cursor,
      };
    }

    let start = text.indexOf(decoded, cursor);
    if (start === -1) {
      start = text.indexOf(decoded);
    }

    if (start === -1) {
      throw new Error(`Failed to locate token "${decoded}" in source text.`);
    }

    const end = start + decoded.length;
    cursor = end;

    return {
      ...token,
      start,
      end,
    };
  });
}

function groupBioUlEntities(tokens, text) {
  if (!Array.isArray(tokens) || !tokens.length) {
    return [];
  }

  const mergeAdjacentSpans = (spans) => {
    if (!spans.length) {
      return [];
    }

    const merged = [{ ...spans[0] }];

    for (let idx = 1; idx < spans.length; idx += 1) {
      const prev = merged[merged.length - 1];
      const current = spans[idx];
      const isSameLabel = current.entity_group === prev.entity_group;
      const isTouching = current.start <= prev.end + 1;

      if (isSameLabel && isTouching) {
        const newEnd = Math.max(prev.end, current.end);
        const prevLength = prev.end - prev.start || 1;
        const currentLength = current.end - current.start || 1;
        const combinedScore =
          ((prev.score || 0) * prevLength +
            (current.score || 0) * currentLength) /
          (prevLength + currentLength);

        prev.end = newEnd;
        prev.word = text.slice(prev.start, newEnd);
        if (!Number.isNaN(combinedScore) && Number.isFinite(combinedScore)) {
          prev.score = combinedScore;
        }
        continue;
      }

      merged.push({ ...current });
    }

    return merged;
  };

  const looksAggregated = tokens.every(
    (token) =>
      typeof token.start === "number" &&
      typeof token.end === "number" &&
      token.entity_group &&
      !token.entity?.includes("-") &&
      !token.entity_group.includes("-")
  );

  if (looksAggregated) {
    const aggregated = tokens
      .filter((token) => token.entity_group && token.entity_group !== "O")
      .map((token) => ({
        entity_group: token.entity_group,
        word:
          token.word && token.word.trim()
            ? token.word
            : text.slice(token.start, token.end),
        start: token.start,
        end: token.end,
        score: token.score,
      }));
    return mergeAdjacentSpans(aggregated);
  }

  const resolvedTokens = attachOffsetsFromPredictions(tokens, text)
    .filter(
      (token) =>
        typeof token.start === "number" &&
        typeof token.end === "number" &&
        token.start !== null &&
        token.end !== null
    )
    .sort((a, b) => a.start - b.start);

  if (resolvedTokens.length !== tokens.length) {
    throw new Error("Token offsets missing; cannot group BIOUL entities.");
  }

  const spans = [];
  let current = null;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    const score =
      current.scores.reduce((sum, value) => sum + value, 0) /
      current.scores.length;
    spans.push({
      entity_group: current.label,
      word: text.slice(current.start, current.end),
      start: current.start,
      end: current.end,
      score,
    });
    current = null;
  };

  for (const token of resolvedTokens) {
    const rawEntity = token.entity || token.entity_group || "O";
    if (rawEntity === "O") {
      continue;
    }

    const [tag, label] = rawEntity.split("-");
    if (!label) {
      throw new Error(`Invalid entity format: "${rawEntity}".`);
    }

    if (tag === "U") {
      flushCurrent();
      spans.push({
        entity_group: label,
        word: text.slice(token.start, token.end),
        start: token.start,
        end: token.end,
        score: token.score,
      });
      continue;
    }

    if (tag === "B") {
      flushCurrent();
      current = {
        label,
        start: token.start,
        end: token.end,
        scores: [token.score],
      };
      continue;
    }

    if (!current || current.label !== label) {
      flushCurrent();
      current = {
        label,
        start: token.start,
        end: token.end,
        scores: [token.score],
      };
      if (tag === "L") {
        flushCurrent();
      }
      continue;
    }

    current.end = token.end;
    current.scores.push(token.score);

    if (tag === "L") {
      flushCurrent();
    }
  }

  flushCurrent();
  return mergeAdjacentSpans(spans);
}

async function handleClassification({ id, text }) {
  try {
    if (typeof text !== "string" || !text.length) {
      self.postMessage({
        type: "result",
        id,
        spans: [],
      });
      return;
    }

    if (!classifierPromise) {
      classifierPromise = pipeline("token-classification", "deid_roberta_i2b2", {
        device: currentDevice,
      });
    }

    const classifier = await classifierPromise;
    const chunks = splitIntoChunks(text, 1000);

    if (!chunks.length) {
      self.postMessage({
        type: "result",
        id,
        spans: [],
      });
      return;
    }

    const allSpans = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const predictions = await classifier(chunk.text, {
        aggregation_strategy: "none",
        ignore_labels: [],
      });

      const spans = groupBioUlEntities(predictions, chunk.text).map((span) => ({
        ...span,
        start: span.start + chunk.start,
        end: span.end + chunk.start,
      }));

      allSpans.push(...spans);

      self.postMessage({
        type: "progress",
        id,
        completed: index + 1,
        total: chunks.length,
      });
    }

    self.postMessage({
      type: "result",
      id,
      spans: allSpans,
    });
  } catch (error) {
    console.error("Worker classification error:", error);
    self.postMessage({
      type: "error",
      id,
      message: error?.message || "Unknown error.",
    });
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if (data.type === "configure") {
    currentDevice = data.device === "webgpu" ? "webgpu" : "wasm";
    classifierPromise = null;
    if (currentDevice === "webgpu") {
      env.backends.onnx.device = 'webgpu';
    } else {
      env.backends.onnx.device = 'wasm';
    }
    return;
  }

  if (data.type === "classify") {
    processingQueue = processingQueue.then(() => handleClassification(data));
  }
});
