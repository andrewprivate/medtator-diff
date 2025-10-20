let Model = null;
const EXCLUDED_TAGS = new Set(["link", "link2tags", "other"]);
const modelState = {
    annotations: [],
    model: null,
    reports: [],
};
let modelViewEl;
let modelViewEmptyEl;

document.addEventListener("DOMContentLoaded", () => {
    const dropzones = document.querySelectorAll(".dropzone");
    modelViewEl = document.getElementById("modelView");
    modelViewEmptyEl = document.getElementById("modelViewEmpty");

    const readDirectoryEntries = (reader) =>
        new Promise((resolve, reject) => {
            const entries = [];
            const readBatch = () => {
                reader.readEntries(
                    (batch) => {
                        if (!batch.length) {
                            resolve(entries);
                            return;
                        }
                        entries.push(...batch);
                        readBatch();
                    },
                    (error) => reject(error)
                );
            };
            readBatch();
        });

    const fileFromEntry = (entry, prefix) =>
        new Promise((resolve, reject) => {
            entry.file(
                (file) => {
                    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
                    if (!file.webkitRelativePath) {
                        Object.defineProperty(file, "webkitRelativePath", {
                            configurable: true,
                            enumerable: true,
                            value: relativePath,
                        });
                    }
                    resolve(file);
                },
                (error) => reject(error)
            );
        });

    const gatherFromEntry = async (entry, prefix = "") => {
        if (entry.isFile) {
            const file = await fileFromEntry(entry, prefix);
            return [file];
        }

        if (entry.isDirectory) {
            const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
            const reader = entry.createReader();
            const entries = await readDirectoryEntries(reader);
            const collected = await Promise.all(
                entries.map((child) => gatherFromEntry(child, nextPrefix))
            );
            return collected.flat();
        }

        return [];
    };

    const collectFilesFromItems = async (items) => {
        const entries = Array.from(items)
            .map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
            .filter(Boolean);

        const files = [];
        for (const entry of entries) {
            // eslint-disable-next-line no-await-in-loop
            const batch = await gatherFromEntry(entry);
            files.push(...batch);
        }
        return files;
    };

    dropzones.forEach((zone) => {
        const inputId = zone.dataset.input;
        const input = document.getElementById(inputId);
        const statusEl = zone.querySelector(".dropzone__status");
        const allowedExtensions = (zone.dataset.ext || "")
            .split(",")
            .map((ext) => ext.trim().toLowerCase())
            .filter(Boolean);
        const extensionLabel = zone.dataset.label || "matching";

        if (!input) {
            return;
        }

        const setStatus = (files) => {
            if (!files || files.length === 0) {
                statusEl.textContent = "";
                return;
            }

            const filteredFiles =
                allowedExtensions.length === 0
                    ? files
                    : files.filter((file) =>
                        allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))
                    );

            if (filteredFiles.length === 0) {
                statusEl.textContent = `Loaded ${files.length} item${files.length === 1 ? "" : "s"} — no ${extensionLabel} files detected.`;
            } else {
                statusEl.textContent = `Loaded ${filteredFiles.length} ${extensionLabel} file${filteredFiles.length === 1 ? "" : "s"}.`;
            }
        };

        const parseAndProcessPrimary = async (files) => {
            if (inputId !== "primaryDirectory") {
                return;
            }

            const relevantFiles =
                allowedExtensions.length === 0
                    ? files
                    : files.filter((file) =>
                        allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))
                    );

            if (relevantFiles.length === 0) {
                modelState.annotations = [];
                modelState.model = null;
                Model = null;
                renderModel(modelState);
                return;
            }

            try {
                const parsed = await Promise.all(
                    relevantFiles.map((file) =>
                        parseAnnotationFile({
                            file,
                            path: file.webkitRelativePath || file.name,
                        })
                    )
                );
                processParsedAnnotations(parsed);
            } catch (error) {
                /* eslint-disable-next-line no-console */
                console.error("Failed to parse XML annotations", error);
                modelState.annotations = [];
                modelState.model = null;
                Model = null;
                renderModel(modelState);
            }
        };

        const parseAndProcessTxtReports = async (files) => {
            if (inputId !== "secondaryDirectory") {
                return;
            }

            const relevantFiles =
                allowedExtensions.length === 0
                    ? files
                    : files.filter((file) =>
                        allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))
                    );

            if (relevantFiles.length === 0) {
                modelState.reports = [];
                renderModel(modelState);
                return;
            }

            const reports = [];

            for (const file of relevantFiles) {
                try {
                    const content = await readFile(file);
                    const parsedReport = parseTxtReport(content);
                    reports.push({
                        ...parsedReport,
                        fileName: file.name,
                        sourcePath: file.webkitRelativePath || file.name,
                    });
                } catch (error) {
                    /* eslint-disable-next-line no-console */
                    console.error(`Failed to parse TXT report: ${file.name}`, error);
                }
            }

            modelState.reports = reports;
            renderModel(modelState);
        };

        const handleFilesUpdate = (files) => {
            setStatus(files);
            if (inputId === "primaryDirectory") {
                void parseAndProcessPrimary(files);
            } else if (inputId === "secondaryDirectory") {
                void parseAndProcessTxtReports(files);
            }
        };

        const activate = () => zone.classList.add("dropzone--active");
        const deactivate = () => zone.classList.remove("dropzone--active");

        let dragDepth = 0;

        zone.addEventListener("click", () => input.click());

        zone.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                input.click();
            }
        });

        zone.addEventListener("dragenter", (event) => {
            event.preventDefault();
            dragDepth += 1;
            activate();
        });

        zone.addEventListener("dragover", (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            activate();
        });

        zone.addEventListener("dragleave", (event) => {
            event.preventDefault();
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) {
                deactivate();
            }
        });

        zone.addEventListener("dragend", () => {
            dragDepth = 0;
            deactivate();
        });

        zone.addEventListener("drop", async (event) => {
            event.preventDefault();
            dragDepth = 0;
            deactivate();

            const { files, items } = event.dataTransfer || {};
            if (!files && !items) {
                return;
            }

            let gathered = [];
            if (items && items.length) {
                try {
                    gathered = await collectFilesFromItems(items);
                } catch (error) {
                    /* eslint-disable-next-line no-console */
                    console.error("Failed to traverse dropped items", error);
                    gathered = Array.from(files || []);
                }
            } else {
                gathered = Array.from(files);
            }

            if (typeof DataTransfer === "function") {
                const dataTransfer = new DataTransfer();
                gathered.forEach((file) => dataTransfer.items.add(file));
                input.files = dataTransfer.files;
                handleFilesUpdate(Array.from(input.files));
            } else {
                /* eslint-disable-next-line no-console */
                console.warn("DataTransfer constructor unsupported - files not assigned to input");
                handleFilesUpdate(gathered);
            }
        });

        input.addEventListener("change", () => {
            handleFilesUpdate(Array.from(input.files));
        });
    });
});

async function readFile(f) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsText(f);
    });
}

async function parseAnnotationFile({
    file,
    path
}) {
    const content = await readFile(file);
    const xmlDoc = new DOMParser().parseFromString(content, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML');
    const textEl = xmlDoc.querySelector('TEXT');
    if (!textEl) throw new Error('Missing TEXT');
    const tagsEl = xmlDoc.querySelector('TAGS');
    if (!tagsEl) throw new Error('Missing TAGS');
    const obj = {
        fileName: file.name,
        sourcePath: path,
        text: textEl.textContent,
        tags: Array.from(tagsEl.children)
            .filter(
                (tag) =>
                    tag.hasAttribute("spans") &&
                    !EXCLUDED_TAGS.has(tag.tagName.toLowerCase())
            )
            .map((tag) => {
                const textAttr = tag.getAttribute("text") ?? "";
                const spanAttr = tag.getAttribute("spans") ?? "";
                const texts = textAttr.split("...");
                const spansAttr = spanAttr.split(",");
                if (texts.length !== spansAttr.length) throw new Error("Mismatch texts vs spans");
                const spans = spansAttr.map((s, idx) => {
                    const [start, end] = s.split("~").map((n) => parseInt(n, 10));
                    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("Bad span");
                    return {
                        start,
                        end,
                        text: texts[idx],
                    };
                });
                const props = {};
                for (const at of tag.attributes) {
                    if (["spans", "text", "id"].includes(at.name)) continue;
                    props[at.name] = at.value;
                }
                return {
                    name: tag.tagName,
                    spans,
                    properties: props,
                };
            }),
    };
    obj.spans = [];
    obj.tags.forEach(t => t.spans.forEach(sp => obj.spans.push({
        start: sp.start,
        end: sp.end,
        text: sp.text,
        properties: t.properties,
        filename: obj.name,
        originPath: path,
        name: t.name
    })));
    obj.spans.sort((a, b) => a.start - b.start || a.end - b.end);
    return obj;
}

const SUMMARY_LABEL_MAP = {
    "provider notes": "providerNotes",
    "allied health notes": "alliedHealthNotes",
    "geriatrics/integrative/psychiatry": "gipNotes",
    "nursing notes": "nursingNotes",
    "occupational therapy": "otNotes",
    "physical therapy": "ptNotes",
};

const SECTION_TITLE_MAP = {
    "GERIATRICS NOTES": "geriatricsEntries",
    "INTEGRATIVE MEDICINE NOTES": "integrativeEntries",
    "PSYCHIATRY NOTES": "psychiatryEntries",
    "NURSING NOTES": "nursingEntries",
    "OCCUPATIONAL THERAPY NOTES": "otEntries",
    "PHYSICAL THERAPY NOTES": "ptEntries",
    "CARE PLAN NOTES": "carePlanEntries",
    "SOCIAL WORKER NOTES": "socialWorkerEntries",
};

function parseTxtReport(content) {
    if (typeof content !== "string") {
        throw new Error("TXT report content must be a string");
    }

    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    let index = 0;
    const report = {
        title: "",
        isDeidentified: false,
        isOriginal: false,
        startDate: null,
        endDate: null,
        extractionDate: null,
        summary: [],
        summaryMap: {},
        sections: [],
    };

    const peekLine = () => (index < lines.length ? lines[index] : null);
    const nextLine = () => (index < lines.length ? lines[index++] : null);
    const skipBlankLines = () => {
        while (index < lines.length && lines[index].trim() === "") {
            index++;
        }
    };

    skipBlankLines();
    if (/^=+$/.test((peekLine() || "").trim())) {
        index++;
    }
    skipBlankLines();

    if (peekLine() !== null) {
        report.title = (nextLine() || "").trim();
        report.isDeidentified = /DE-IDENTIFIED/i.test(report.title);
        report.isOriginal = /ORIGINAL/i.test(report.title);
    }

    if (/^=+$/.test((peekLine() || "").trim())) {
        index++;
    }
    skipBlankLines();

    while (index < lines.length) {
        const line = (peekLine() || "").trim();
        if (!line) {
            index++;
            continue;
        }
        if (/^SUMMARY:?$/i.test(line)) {
            break;
        }
        if (/^Date Range:/i.test(line)) {
            const match = line.match(/^Date Range:\s*(.+?)\s*-\s*(.+)$/i);
            if (match) {
                report.startDate = match[1].trim();
                report.endDate = match[2].trim();
            }
            index++;
            continue;
        }
        if (/^Extraction Date:/i.test(line)) {
            report.extractionDate = line.replace(/^Extraction Date:\s*/i, "").trim();
            index++;
            continue;
        }
        index++;
    }

    if (/^SUMMARY:?$/i.test((peekLine() || "").trim())) {
        index++;
    }
    if (/^-+$/.test((peekLine() || "").trim())) {
        index++;
    }

    while (index < lines.length) {
        const raw = peekLine();
        if (raw == null) {
            break;
        }
        const trimmed = raw.trim();
        if (!trimmed) {
            index++;
            break;
        }

        const match = trimmed.match(/^(.+?):\s*(\d+)\s+entries?/i);
        if (!match) {
            index++;
            break;
        }

        // const label = match[1].trim();
        // const count = parseInt(match[2], 10);
        // const key = mapSummaryLabel(label);

        // const summaryEntry = { label, count, key };
        // report.summary.push(summaryEntry);
        // if (key) {
        //     report.summaryMap[key] = count;
        // }
        index++;
    }

    while (index < lines.length) {
        skipBlankLines();
        const headerLine = peekLine();
        if (!headerLine) {
            break;
        }
        const trimmedHeader = headerLine.trim();
        if (!trimmedHeader) {
            index++;
            continue;
        }

        const headerUnderline = (lines[index + 1] || "").trim();
        if (!/^=+$/.test(headerUnderline)) {
            index++;
            continue;
        }

        index += 2; // skip header + underline
        skipBlankLines();

        const entries = [];
        while (index < lines.length) {
            const currentLine = peekLine();
            if (currentLine == null) {
                break;
            }

            const currentTrim = currentLine.trim();
            if (!currentTrim) {
                index++;
                continue;
            }

            const nextLineTrim = (lines[index + 1] || "").trim();
            if (
                /^[A-Z][A-Z0-9/&(),. ':-]*$/.test(currentTrim) &&
                /^=+$/.test(nextLineTrim)
            ) {
                break;
            }

            const entryMatch = currentTrim.match(/^Entry\s+(\d+):/i);
            if (entryMatch) {
                index++; // move past "Entry N:"
                if (/^-+$/.test((peekLine() || "").trim())) {
                    index++;
                }
                const entryLines = [];
                while (index < lines.length) {
                    const innerLine = peekLine();
                    if (innerLine == null) {
                        break;
                    }
                    const innerTrim = innerLine.trim();
                    if (/^-{20,}$/.test(innerTrim)) {
                        index++;
                        break;
                    }
                    entryLines.push(innerLine);
                    index++;
                }
                while (index < lines.length && lines[index].trim() === "") {
                    index++;
                }
                const entry = parseTxtReportEntry(entryLines);
                entry.entryNumber = parseInt(entryMatch[1], 10) || entries.length + 1;
                entries.push(entry);
                continue;
            }

            index++;
        }

        const titleUpper = trimmedHeader.toUpperCase();
        const sectionKey = mapSectionTitle(titleUpper);
        const sectionInfo = {
            title: capitalizeSectionTitle(trimmedHeader),
            key: sectionKey,
            entries,
        };
        report.sections.push(sectionInfo);
        if (sectionKey) {
            report[sectionKey] = entries;
        }
    }

    report.summary = Object.keys(SECTION_TITLE_MAP).map((key) => {
        const entries = report[SECTION_TITLE_MAP[key]];
        return {
            label: key,
            count: Array.isArray(entries) ? entries.length : 0,
        };
    });

    return report;
}

function parseTxtReportEntry(entryLines) {
    const entry = {
        data: {},
        structuredNotes: [],
        notesText: "",
        notesError: null,
    };

    let i = 0;
    while (i < entryLines.length) {
        const line = entryLines[i] ?? "";
        const trimmed = line.trim();
        if (!trimmed) {
            i++;
            continue;
        }

        if (trimmed === "NOTES:") {
            i++;
            while (i < entryLines.length) {
                const noteLine = entryLines[i] ?? "";
                const noteTrim = noteLine.trim();
                if (!noteTrim) {
                    i++;
                    continue;
                }
                if (noteTrim === "NOTES TEXT:" || noteTrim.startsWith("ERROR:")) {
                    break;
                }
                const colonIdx = noteLine.indexOf(":");
                if (colonIdx !== -1) {
                    const header = noteLine.slice(0, colonIdx).trim();
                    const text = noteLine.slice(colonIdx + 1).trim();
                    if (header || text) {
                        entry.structuredNotes.push({ header, text });
                    }
                }
                i++;
            }
            continue;
        }

        if (trimmed === "NOTES TEXT:") {
            i++;
            const noteLines = [];
            while (i < entryLines.length) {
                const noteLine = entryLines[i] ?? "";
                const noteTrim = noteLine.trim();
                if (noteTrim.startsWith("ERROR:")) {
                    break;
                }
                noteLines.push(noteLine);
                i++;
            }
            entry.notesText = trimTrailingLines(noteLines);
            continue;
        }

        if (trimmed.startsWith("ERROR:")) {
            entry.notesError = trimmed.slice("ERROR:".length).trim();
            i++;
            continue;
        }

        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            if (key) {
                entry.data[key] = value;
            }
        }
        i++;
    }

    return entry;
}

function trimTrailingLines(lines) {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === "") {
        end -= 1;
    }
    return lines.slice(0, end).join("\n");
}

function mapSummaryLabel(label) {
    if (!label) {
        return null;
    }
    const normalized = label.toLowerCase();
    return SUMMARY_LABEL_MAP[normalized] || null;
}

function mapSectionTitle(titleUpper) {
    return SECTION_TITLE_MAP[titleUpper] || null;
}

function capitalizeSectionTitle(title) {
    return title
        .toLowerCase()
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function processParsedAnnotations(parsedAnnotations) {
    /* eslint-disable-next-line no-console */
    console.log("Parsed annotations ready for processing", parsedAnnotations);

    const allSpans = parsedAnnotations.flatMap(pa => pa.spans);

    const allTags = new Set();
    parsedAnnotations.forEach(pa => {
        pa.spans.forEach(sp => {
            allTags.add(sp.name);
        });
    });

    const allPropertiesAndValues = new Map();
    parsedAnnotations.forEach(pa => {
        pa.spans.forEach(sp => {
            Object.keys(sp.properties).forEach(prop => {
                if (!allPropertiesAndValues.has(prop)) {
                    allPropertiesAndValues.set(prop, new Set());
                }
                allPropertiesAndValues.get(prop).add(sp.properties[prop]);
            });
        });
    });


    const positiveMatchConfig = {
        tags: new Set(),
        requiredPropertyValues: new Map(),
    }

    const negativeMatchConfig = {
        tags: new Set(),
        requiredPropertyValues: new Map()
    }

    // hardcoded for now
    allTags.forEach(tag => {
        if (!(tag === "Link" || tag === "Link2Tags" || tag === "Other")) {
            positiveMatchConfig.tags.add(tag);
            negativeMatchConfig.tags.add(tag);
        }
    });

    allPropertiesAndValues.forEach((values, prop) => {
        if (prop !== "exclusion") {
            positiveMatchConfig.requiredPropertyValues.set(prop, new Set(values));
            negativeMatchConfig.requiredPropertyValues.set(prop, new Set(values));
            return;
        }


        const positiveValues = new Set(["no", ""]);
        const negativeValues = new Set(["yes"]);
        positiveMatchConfig.requiredPropertyValues.set(prop, positiveValues);
        negativeMatchConfig.requiredPropertyValues.set(prop, negativeValues);
    });

    const positiveMatches = allSpans.filter(sp => spanMatchesConfig(sp, positiveMatchConfig));
    const negativeMatches = allSpans.filter(sp => spanMatchesConfig(sp, negativeMatchConfig));

    const positiveMatchStrings = extractStringsFromSpans(positiveMatches);
    const negativeMatchStrings = extractStringsFromSpans(negativeMatches);
    console.log(negativeMatchConfig)


    // Remove any strings from negative matches that also appear in positive matches
    negativeMatchStrings.forEach((negSet, tag) => {
        if (positiveMatchStrings.has(tag)) {
            const posSet = positiveMatchStrings.get(tag);
            posSet.forEach(str => {
                if (negSet.has(str)) {
                    negSet.delete(str);
                    if (negSet.size === 0) {
                        negativeMatchStrings.delete(tag);
                    }
                }
            });
        }
    });


    /* eslint-disable-next-line no-console */
    console.log("Positive match strings:", positiveMatchStrings);
    /* eslint-disable-next-line no-console */
    console.log("Negative match strings:", negativeMatchStrings);

    Model = {
        positive: positiveMatchStrings,
        negative: negativeMatchStrings,
        tags: Array.from(allTags),
    };

    modelState.annotations = parsedAnnotations;
    modelState.model = Model;
    renderModel(modelState);
}

function spanMatchesConfig(span, config) {
    if (config.tags.size > 0 && !config.tags.has(span.name)) {
        return false;
    }

    for (const prop in span.properties) {
        if (config.requiredPropertyValues.has(prop)) {
            const allowedValues = config.requiredPropertyValues.get(prop);
            if (!allowedValues.has(span.properties[prop])) {
                return false;
            }
        }
    }

    return true;
}

function applyModelToNote(notes, model) {
    const sections = notes.sections;
    const overallMatchSummary = {};
    for (const tag of model.tags) {
        overallMatchSummary[tag] = 0;
    }

    sections.forEach(section => {
        const sectionMatchSummary = {};
        for (const tag of model.tags) {
            sectionMatchSummary[tag] = 0;
        }

        section.entries.forEach(entry => {
            let text = entry.notesText || "";
            if (entry.structuredNotes && entry.structuredNotes.length > 0) {
                text += "\n" + entry.structuredNotes.map(sn => sn.text).join("\n");
            }
            const matches = applyModelToText(text, model);
            entry.modelMatches = matches;
            entry.concepts = matches.size > 0 ? Array.from(matches.keys()) : [];
            matches.forEach((matchList, tag) => {
                sectionMatchSummary[tag] += matchList.length;
                overallMatchSummary[tag] += matchList.length;
            });
        });
        section.matchSummary = sectionMatchSummary;
    });

    notes.matchSummary = overallMatchSummary;
}

function applyModelToText(text, model) {
    const cleanedText = cleanText(text); // add padding to help with matching at edges
    const tags = model.tags;

    const results = new Map();

    for (const tag of tags) {
        const positivePhrases = Array.from(model.positive.get(tag) || []);
        const negativePhrases = Array.from(model.negative.get(tag) || []);

        const positiveMatches = getMatchedPhrases(cleanedText, positivePhrases);
        const negativeMatches = getMatchedPhrases(cleanedText, negativePhrases);

        // remove from positive matches any that overlap with negative matches
        const filteredPositiveMatches = positiveMatches.filter(pm => {
            for (const nm of negativeMatches) {
                if (!(pm.end < nm.start || pm.start > nm.end)) {
                    return false;
                }
            }
            return true;
        });

        // Combine overlapping positive matches
        const combinedMatches = [];
        const currentGroup = [];
        filteredPositiveMatches.sort((a, b) => a.start - b.start);
        for (const match of filteredPositiveMatches) {
            if (currentGroup.length === 0) {
                currentGroup.push(match);
            } else {
                const start = currentGroup[0].start;
                const end = currentGroup[currentGroup.length - 1].end;
                if (match.start <= end) {
                    currentGroup.push(match);
                } else {
                    combinedMatches.push({
                        phrases: currentGroup.map(m => m.phrase),
                        start,
                        end
                    });
                    currentGroup.length = 0;
                }
            }
        }
        if (currentGroup.length > 0) {
            const start = currentGroup[0].start;
            const end = currentGroup[currentGroup.length - 1].end;
            combinedMatches.push({
                phrases: currentGroup.map(m => m.phrase),
                start,
                end
            });
        }

        if (combinedMatches.length > 0) {
            results.set(tag, combinedMatches);
        }
    }
    return results;
}

function getMatchedPhrases(text, phrases) {
    const matches = [];
    const textToMatch = ` ${text} `; // add padding to help with matching at edges
    phrases.forEach((phrase) => {
        const cleanedPhrase = ` ${cleanText(phrase)} `;
        let startIndex = 0;
        while (startIndex < textToMatch.length) {
            const index = textToMatch.indexOf(cleanedPhrase, startIndex);
            if (index === -1) {
                break;
            }
            matches.push({
                phrase: phrase,
                start: index - 1, // adjust for padding
                end: index - 1 + cleanedPhrase.length - 2, // adjust for padding
            });
            startIndex = index + cleanedPhrase.length;
        }
    });
    return matches;
}

function extractStringsFromSpans(spans) {
    const results = new Map();
    spans.forEach(sp => {
        const tag = sp.name;
        if (!results.has(tag)) {
            results.set(tag, new Set());
        }
        results.get(tag).add(cleanText(sp.text));
    });
    return results;
}

function cleanText(text) {
    const cleaned = text.replace(/[^a-zA-Z0-9 -:]/g, ' ').toLowerCase();
    // remove duplicate spaces
    return cleaned.replace(/\s+/g, ' ').trim();
}

function renderModel(state) {
    if (!modelViewEl || !modelViewEmptyEl) {
        return;
    }

    const annotations = Array.isArray(state.annotations) ? state.annotations : [];
    const reports = Array.isArray(state.reports) ? state.reports : [];
    const model = state.model;
    const hasAnnotations = annotations.length > 0;
    const hasReports = reports.length > 0;

    if (!hasAnnotations && !hasReports) {
        modelViewEl.innerHTML = "";
        modelViewEl.hidden = true;
        modelViewEmptyEl.hidden = false;
        return;
    }

    modelViewEmptyEl.hidden = true;
    modelViewEl.hidden = false;
    modelViewEl.innerHTML = "";

    if (modelState.model && hasReports) {
        reports.forEach(report => {
            applyModelToNote(report, modelState.model);
        });
    }

    if (hasAnnotations) {
        const xmlSection = createElement("section", "model-section");
        xmlSection.append(createElement("h3", "model-subheading", "Parsed XML annotations"));
        xmlSection.append(createSummaryElement(annotations, model));
        xmlSection.append(createMatchGrid(model));
        modelViewEl.append(xmlSection);
    }

    if (hasReports) {
        modelViewEl.append(createReportsSection(reports));
    }
}

function createSummaryElement(annotations, model) {
    const summary = createElement("div", "model-summary");
    const totalTags = annotations.reduce(
        (accumulator, annotation) => accumulator + (annotation.tags ? annotation.tags.length : 0),
        0
    );
    const totalSpans = annotations.reduce(
        (accumulator, annotation) => accumulator + (annotation.spans ? annotation.spans.length : 0),
        0
    );

    const metrics = [
        { label: "Documents", value: annotations.length },
        { label: "Tags", value: totalTags },
        { label: "Spans", value: totalSpans },
        { label: "Positive phrases", value: countMatchStrings(model && model.positive) },
        { label: "Negative phrases", value: countMatchStrings(model && model.negative) },
    ];

    metrics.forEach(({ label, value }) => {
        const metric = createElement("div", "summary-metric");
        metric.append(
            createElement("span", "summary-metric__value", String(value)),
            createElement("span", "summary-metric__label", label)
        );
        summary.append(metric);
    });

    return summary;
}

function createMatchGrid(model) {
    const grid = createElement("div", "match-grid");
    const positiveMap = model && model.positive ? model.positive : null;
    const negativeMap = model && model.negative ? model.negative : null;

    grid.append(
        createMatchColumn("Positive matches", positiveMap),
        createMatchColumn("Negative matches", negativeMap)
    );

    return grid;
}

function createMatchSummary(matchSummary, titleText) {
    const container = createElement("div", "match-summary");
    if (titleText) {
        container.append(createElement("h4", "match-summary__title", titleText));
    }

    const entries = Object.entries(matchSummary || {});
    if (entries.length === 0) {
        container.append(createElement("p", "match-summary__empty", "No matches available."));
        return container;
    }

    const normalized = entries.map(([tag, count]) => ({
        tag,
        count: Number.isFinite(count) ? count : Number(count) || 0,
    }));

    const positive = normalized.filter((item) => item.count > 0);
    const itemsToDisplay = positive.length > 0 ? positive : normalized;

    if (itemsToDisplay.length === 0) {
        container.append(createElement("p", "match-summary__empty", "No matches available."));
        return container;
    }

    itemsToDisplay.sort((a, b) => {
        if (b.count !== a.count) {
            return b.count - a.count;
        }
        return a.tag.localeCompare(b.tag);
    });

    const grid = createElement("div", "match-summary__grid");
    itemsToDisplay.forEach(({ tag, count }) => {
        const item = createElement("div", "match-summary__item");
        item.append(
            createElement("span", "match-summary__value", String(count)),
            createElement("span", "match-summary__label", tag)
        );
        grid.append(item);
    });

    container.append(grid);
    return container;
}

function createMatchColumn(title, matchMap) {
    const column = createElement("section", "match-column");
    column.append(createElement("h3", "match-column__title", title));

    if (!matchMap || matchMap.size === 0) {
        column.append(createElement("p", "match-column__empty", "No matches found."));
        return column;
    }

    const list = createElement("div", "match-list");
    const tags = Array.from(matchMap.keys()).sort((a, b) => a.localeCompare(b));

    tags.forEach((tag) => {
        const phrases = matchMap.get(tag);
        const item = createElement("article", "match-item");
        item.append(createElement("span", "tag-pill", tag));

        const phraseList = createElement("ul", "match-phrases");
        Array.from(phrases)
            .sort((a, b) => a.localeCompare(b))
            .forEach((phrase) => {
                phraseList.append(createElement("li", undefined, phrase));
            });

        item.append(phraseList);
        list.append(item);
    });

    column.append(list);
    return column;
}

function createAnnotationCard(annotation) {
    const card = createElement("article", "model-card");

    const header = createElement("header", "model-card__header");
    header.append(
        createElement("h3", "model-card__title", annotation.fileName || "Untitled file"),
        createElement(
            "p",
            "model-card__path",
            annotation.sourcePath || annotation.fileName || "Unknown path"
        )
    );
    card.append(header);

    const textSection = createElement("div", "model-card__section");
    textSection.append(
        createElement("h4", "model-card__section-title", "Document text"),
        createElement("div", "model-card__text", annotation.text || "")
    );
    card.append(textSection);

    const tagsSection = createElement("div", "model-card__section");
    const tagCount = annotation.tags ? annotation.tags.length : 0;
    tagsSection.append(
        createElement("h4", "model-card__section-title", `Tags (${tagCount})`)
    );

    if (tagCount > 0) {
        const tagList = createElement("div", "tag-list");
        annotation.tags.forEach((tag) => {
            tagList.append(createTagItem(tag));
        });
        tagsSection.append(tagList);
    } else {
        tagsSection.append(createElement("p", "empty-hint", "No tags found."));
    }

    card.append(tagsSection);

    return card;
}

function createTagItem(tag) {
    const tagItem = createElement("div", "tag-item");
    tagItem.append(createElement("span", "tag-pill", tag.name || "Untitled tag"));

    const properties = Object.entries(tag.properties || {});
    if (properties.length > 0) {
        const propertyList = createElement("ul", "property-list");
        properties.forEach(([key, value]) => {
            propertyList.append(createElement("li", "property-chip", `${key}: ${value}`));
        });
        tagItem.append(propertyList);
    }

    if (tag.spans && tag.spans.length > 0) {
        const spanList = createElement("ul", "span-list");
        tag.spans.forEach((span) => {
            spanList.append(
                createElement(
                    "li",
                    "span-entry",
                    `[${span.start}-${span.end}] ${span.text || ""}`
                )
            );
        });
        tagItem.append(spanList);
    } else {
        tagItem.append(createElement("p", "tag-item__empty", "No spans recorded."));
    }

    return tagItem;
}

function createReportsSection(reports) {
    const section = createElement("section", "model-section reports-section");

    const header = createElement("div", "reports-header");
    header.append(createElement("h3", "model-subheading", "Parsed TXT reports"));

    if (Array.isArray(reports) && reports.length > 0) {
        const downloadButton = createElement("button", "download-button", "Download results");
        downloadButton.type = "button";
        downloadButton.addEventListener("click", () => exportReportsToCsv(reports));
        header.append(downloadButton);
    }

    section.append(header);
    section.append(createReportOverview(reports));
    reports.forEach((report) => {
        section.append(createReportCard(report));
    });
    return section;
}

function createReportOverview(reports) {
    const overview = createElement("div", "model-summary report-summary");
    const totalEntries = reports.reduce((acc, report) => acc + countReportEntries(report), 0);
    const deidentifiedCount = reports.filter((report) => report.isDeidentified).length;
    const originalCount = reports.length - deidentifiedCount;
    const totalSections = reports.reduce(
        (acc, report) => acc + (Array.isArray(report.sections) ? report.sections.length : 0),
        0
    );

    const metrics = [
        { label: "Reports", value: reports.length },
        { label: "Sections", value: totalSections },
        { label: "Entries", value: totalEntries },
        { label: "De-identified", value: deidentifiedCount },
        { label: "Original", value: originalCount },
    ];

    metrics.forEach(({ label, value }) => {
        const metric = createElement("div", "summary-metric");
        metric.append(
            createElement("span", "summary-metric__value", String(value)),
            createElement("span", "summary-metric__label", label)
        );
        overview.append(metric);
    });

    return overview;
}

function createReportCard(report) {
    const card = createElement("article", "model-card report-card");

    const header = createElement("header", "model-card__header");
    header.append(
        createElement("h3", "model-card__title", report.fileName || "TXT report"),
        createElement("p", "model-card__path", report.sourcePath || report.fileName || "")
    );
    card.append(header);

    const meta = createElement("dl", "report-meta");
    const typeLabel = report.isDeidentified
        ? "De-identified"
        : report.isOriginal
            ? "Original"
            : "Unknown";
    meta.append(
        createElement("dt", undefined, "Type"),
        createElement("dd", undefined, typeLabel)
    );
    if (report.title) {
        meta.append(
            createElement("dt", undefined, "Header"),
            createElement("dd", undefined, report.title)
        );
    }
    if (report.startDate || report.endDate) {
        const range = [report.startDate, report.endDate].filter(Boolean).join(" - ");
        meta.append(createElement("dt", undefined, "Date range"), createElement("dd", undefined, range));
    }
    if (report.extractionDate) {
        meta.append(
            createElement("dt", undefined, "Extraction"),
            createElement("dd", undefined, report.extractionDate)
        );
    }
    card.append(meta);

    const summary = report.summary;

    if (Array.isArray(summary) && summary.length > 0) {
        const summaryGrid = createElement("div", "report-summary-grid");
        summary.forEach((entry) => {
            const item = createElement("div", "report-summary-item");
            item.append(
                createElement("span", "summary-metric__value", String(entry.count)),
                createElement("span", "summary-metric__label", entry.label)
            );
            summaryGrid.append(item);
        });
        card.append(summaryGrid);
    }

    if (report.matchSummary && Object.keys(report.matchSummary).length > 0) {
        card.append(createMatchSummary(report.matchSummary, "Match summary"));
    }

    if (Array.isArray(report.sections) && report.sections.length > 0) {
        const sectionsContainer = createElement("div", "report-sections");
        report.sections.forEach((sectionInfo) => {
            sectionsContainer.append(createReportSection(sectionInfo));
        });
        card.append(sectionsContainer);
    }

    return card;
}

function createReportSection(sectionInfo) {
    const section = createElement("details", "report-section");
    const headingText = `${sectionInfo.title || "Section"} (${(sectionInfo.entries || []).length})`;
    section.append(createElement("summary", "report-section__summary", headingText));

    const body = createElement("div", "report-section__body");
    if (sectionInfo.matchSummary && Object.keys(sectionInfo.matchSummary).length > 0) {
        body.append(createMatchSummary(sectionInfo.matchSummary, "Section match summary"));
    }
    (sectionInfo.entries || []).forEach((entry, index) => {
        body.append(createReportEntry(entry, index));
    });
    section.append(body);
    return section;
}

function createReportEntry(entry, index) {
    const container = createElement("article", "report-entry");
    container.append(
        createElement("h4", "report-entry__title", `Entry ${entry.entryNumber || index + 1}`)
    );

    const dataEntries = Object.entries(entry.data || {});
    if (dataEntries.length > 0) {
        const dataList = createElement("dl", "report-entry__data");
        dataEntries.forEach(([key, value]) => {
            dataList.append(createElement("dt", undefined, key), createElement("dd", undefined, value));
        });
        if (entry.concepts && entry.concepts.length > 0) {
            dataList.append(
                createElement("dt", undefined, "CONCEPTS"),
                createElement("dd", undefined, entry.concepts.join(", "))
            );
        }
        container.append(dataList);
    }

    if (Array.isArray(entry.structuredNotes) && entry.structuredNotes.length > 0) {
        const structured = createElement("div", "notes-block");
        structured.append(createElement("h5", "notes-block__title", "Structured notes"));
        const list = createElement("ul", "notes-block__list");
        entry.structuredNotes.forEach((note) => {
            const item = createElement("li", "notes-block__item");
            item.append(
                createElement("span", "notes-block__header", `${note.header || "Note"}:`),
                createElement("span", "notes-block__text", ` ${note.text || ""}`)
            );
            list.append(item);
        });
        structured.append(list);
        container.append(structured);
    }

    if (entry.notesText) {
        const textBlock = createElement("div", "notes-block");
        textBlock.append(createElement("h5", "notes-block__title", "Notes text"));
        textBlock.append(createElement("pre", "notes-block__pre", entry.notesText));
        container.append(textBlock);
    }

    if (entry.notesError) {
        container.append(
            createElement("p", "notes-block__error", `Error: ${entry.notesError}`)
        );
    }

    return container;
}

function countReportEntries(report) {
    if (!report || !Array.isArray(report.sections)) {
        return 0;
    }
    return report.sections.reduce(
        (acc, section) => acc + ((section.entries && section.entries.length) || 0),
        0
    );
}

function countMatchStrings(matchMap) {
    if (!matchMap) {
        return 0;
    }

    let count = 0;
    matchMap.forEach((phrases) => {
        count += phrases.size;
    });
    return count;
}

function exportReportsToCsv(reports) {
    if (!Array.isArray(reports) || reports.length === 0) {
        /* eslint-disable-next-line no-console */
        console.warn("No reports available to export.");
        return;
    }

    const summaryLabels = new Set();
    const matchTags = new Set();

    reports.forEach((report) => {
        if (Array.isArray(report.summary)) {
            report.summary.forEach((entry) => {
                if (entry && entry.label) {
                    summaryLabels.add(entry.label);
                }
            });
        }

        if (report.matchSummary && typeof report.matchSummary === "object") {
            Object.keys(report.matchSummary).forEach((tag) => {
                matchTags.add(tag);
            });
        }
    });

    const summaryColumns = Array.from(summaryLabels).sort((a, b) => a.localeCompare(b));
    const matchColumns = Array.from(matchTags).sort((a, b) => a.localeCompare(b));
    const headers = ["File Name", ...summaryColumns, ...matchColumns];

    const rows = reports.map((report) => {
        const row = [];
        const fileName = report.fileName || report.sourcePath || "";
        row.push(csvEscape(fileName));

        const summaryMap = new Map();
        if (Array.isArray(report.summary)) {
            report.summary.forEach((entry) => {
                if (!entry || !entry.label) {
                    return;
                }
                summaryMap.set(entry.label, normalizeCount(entry.count));
            });
        }

        summaryColumns.forEach((label) => {
            const value = summaryMap.has(label) ? summaryMap.get(label) : 0;
            row.push(csvEscape(value));
        });

        const matchSummary =
            report.matchSummary && typeof report.matchSummary === "object"
                ? report.matchSummary
                : {};
        matchColumns.forEach((tag) => {
            row.push(csvEscape(normalizeCount(matchSummary[tag])));
        });

        return row.join(",");
    });

    const csvContent = [headers.map(csvEscape).join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.download = `match-summary-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function csvEscape(value) {
    const stringValue = value == null ? "" : String(value);
    if (/[",\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
}

function normalizeCount(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function createElement(tagName, className, textContent) {
    const element = document.createElement(tagName);
    if (className) {
        element.className = className;
    }
    if (typeof textContent === "string") {
        element.textContent = textContent;
    }
    return element;
}
