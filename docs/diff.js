const folderInput = document.getElementById('folderInput');
const annotationSelect = document.getElementById('annotationSelect');
const dropZone = document.getElementById('dropZone');
const resultsDiv = document.getElementById('diffresults');
const modeSelect = document.getElementById('modeSelect');
const showNlChk = document.getElementById('showNewline');

let fileContents = [];
let filesByAnnotation = new Map();
const parsedCache = new Map();
const parsedAnnotationsByFile = new Map();
let optionRefreshToken = 0;
let agreementThreshold = 0.5;
let selectedMatchingProperties = new Set();
let propertySelectionTouched = false;

const EXCLUDED_TAGS = new Set(['link', 'link2tags', 'other']);

const MARKERS = {
    space: '·',
    nbsp: '\\u00A0',
    tab: '\\t',
    lf: '¶',
    cr: '\\r',
    crlf: '¶'
};

const RAW = {
    space: ' ',
    nbsp: '\u00A0',
    tab: '\t',
    lf: '\n',
    cr: '\r',
    crlf: '\r\n'
};

const readFile = f => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsText(f);
});

dropZone.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker === 'function') {
        try {
            const directoryHandle = await window.showDirectoryPicker();
            const collected = await collectFromDirectoryHandle(directoryHandle);
            if (collected.length) {
                ingestFiles(collected);
            } else {
                resultsDiv.innerHTML = '<p>The selected folder did not contain any files.</p>';
            }
        } catch (err) {
            if (err && err.name !== 'AbortError') {
                console.error(err);
                alert('Unable to open that folder: ' + err.message);
            }
        }
    } else {
        folderInput.click();
    }
});

folderInput.addEventListener('change', async e => {
    const fileList = e.target.files;
    if (fileList && fileList.length) {
        ingestFiles(Array.from(fileList));
        folderInput.value = '';
        return;
    }

    const entries = e.target.webkitEntries || folderInput.webkitEntries;
    if (entries && entries.length) {
        try {
            const collected = await collectFromEntries(entries);
            if (collected.length) {
                ingestFiles(collected);
                folderInput.value = '';
                return;
            }
        } catch (err) {
            console.error(err);
            alert('Unable to read that folder: ' + err.message);
        }
    }

    resultsDiv.innerHTML = '<p>Could not access files from the chosen folder. Try dragging the folder into this window instead.</p>';
});

['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('dragover');
}));

dropZone.addEventListener('dragleave', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    try {
        const collected = await collectFromDataTransfer(e.dataTransfer);
        if (collected.length) {
            ingestFiles(collected);
        } else {
            resultsDiv.innerHTML = '<p>The dropped items did not contain any MedTator XML files.</p>';
        }
    } catch (err) {
        console.error(err);
        alert('Unable to read dropped items: ' + err.message);
    }
});

annotationSelect.addEventListener('change', e => {
    const fileName = e.target.value;
    if (!fileName) {
        resultsDiv.innerHTML = '';
        return;
    }
    compareAnnotation(fileName);
});

function resetState() {
    fileContents = [];
    filesByAnnotation = new Map();
    parsedCache.clear();
    parsedAnnotationsByFile.clear();
    selectedMatchingProperties.clear();
    propertySelectionTouched = false;
    annotationSelect.innerHTML = '';
    annotationSelect.disabled = true;
}

function ingestFiles(fileList) {
    resetState();

    const normalized = normalizeFileInputs(fileList);
    const xmlFiles = normalized.filter(entry => entry.file.name.toLowerCase().endsWith('.xml'));
    if (!xmlFiles.length) {
        resultsDiv.innerHTML = '<p>No MedTator XML files detected. Make sure you selected the top-level data folder.</p>';
        return;
    }

    const skippedWithoutAnnotator = [];
    xmlFiles.forEach(({
        file,
        relativePath
    }) => {
        const parts = relativePath.split(/[\\\/]/).filter(Boolean);
        if (parts.length < 2) {
            skippedWithoutAnnotator.push(relativePath);
            return;
        }
        const annotator = parts[parts.length - 2];
        const fileName = parts[parts.length - 1];
        if (!filesByAnnotation.has(fileName)) filesByAnnotation.set(fileName, []);
        filesByAnnotation.get(fileName).push({
            annotator,
            file,
            path: relativePath
        });
    });

    if (!filesByAnnotation.size) {
        resultsDiv.innerHTML = '<p>Did not find any annotator subfolders with XML files.</p>';
        return;
    }

    const fragment = document.createDocumentFragment();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select annotation file…';
    fragment.appendChild(placeholder);

    Array.from(filesByAnnotation.entries())
        .sort((a, b) => a[0].localeCompare(b[0], undefined, {
            numeric: true,
            sensitivity: 'base'
        }))
        .forEach(([fileName, entries]) => {
            const opt = document.createElement('option');
            opt.value = fileName;
            const annotators = entries.map(e => e.annotator).sort((a, b) => a.localeCompare(b, undefined, {
                sensitivity: 'base'
            }));
            const baseLabel = `${fileName} (${annotators.length} annotator${annotators.length === 1 ? '' : 's'})`;
            opt.textContent = baseLabel;
            opt.dataset.baseLabel = baseLabel;
            opt.dataset.annotators = annotators.join(', ');
            fragment.appendChild(opt);
        });

    annotationSelect.appendChild(fragment);
    annotationSelect.disabled = false;

    if (skippedWithoutAnnotator.length) {
        console.warn('Files without annotator folder were skipped:', skippedWithoutAnnotator);
    }

    resultsDiv.innerHTML = '<p>Choose an annotation file from the dropdown to compare annotators.</p>';

    refreshFileOptionScores(selectedMatchingProperties).catch(err => {
        console.error('Unable to compute per-file scores', err);
    });
}

function normalizeFileInputs(items) {
    if (!items || !items.length) return [];
    return items.map(item => {
        if (item instanceof File) {
            return {
                file: item,
                relativePath: item.webkitRelativePath || item.name
            };
        }
        if (item && item.file instanceof File) {
            const relativePath = item.relativePath || item.file.webkitRelativePath || item.file.name;
            return {
                file: item.file,
                relativePath
            };
        }
        return null;
    }).filter(Boolean);
}

async function collectFromDirectoryHandle(handle, prefix = '') {
    const collected = [];
    for await (const [name, child] of handle.entries()) {
        if (child.kind === 'file') {
            const file = await child.getFile();
            collected.push({
                file,
                relativePath: `${prefix}${name}`
            });
        } else if (child.kind === 'directory') {
            const nested = await collectFromDirectoryHandle(child, `${prefix}${name}/`);
            collected.push(...nested);
        }
    }
    return collected;
}

async function collectFromEntries(entries) {
    const entryList = Array.from(entries);
    const collected = [];
    for (const entry of entryList) {
        const files = await walkEntry(entry);
        collected.push(...files);
    }
    return collected;
}

async function collectFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];

    const items = Array.from(dataTransfer.items || []);
    const collected = [];

    if (items.length) {
        for (const item of items) {
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (entry) {
                const files = await walkEntry(entry);
                collected.push(...files);
            } else if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    collected.push({
                        file,
                        relativePath: file.webkitRelativePath || file.name
                    });
                }
            }
        }
    }

    if (!collected.length && dataTransfer.files && dataTransfer.files.length) {
        collected.push(...normalizeFileInputs(Array.from(dataTransfer.files)));
    }

    return collected;
}

async function walkEntry(entry, parentPath = '') {
    if (!entry) return [];

    if (entry.isFile) {
        return new Promise((resolve, reject) => {
            entry.file(file => {
                resolve([{
                    file,
                    relativePath: `${parentPath}${entry.name}`
                }]);
            }, reject);
        });
    }

    if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await readAllEntries(reader);
        const collected = [];
        const nextPath = `${parentPath}${entry.name}/`;
        for (const child of entries) {
            const files = await walkEntry(child, nextPath);
            collected.push(...files);
        }
        return collected;
    }

    return [];
}

function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
        const results = [];

        function readBatch() {
            reader.readEntries(entries => {
                if (!entries.length) {
                    resolve(results);
                } else {
                    results.push(...entries);
                    readBatch();
                }
            }, reject);
        }
        readBatch();
    });
}

async function compareAnnotation(fileName) {
    const entries = filesByAnnotation.get(fileName) || [];
    if (!entries.length) {
        resultsDiv.innerHTML = '<p>No files found for the selected annotation.</p>';
        return;
    }

    resultsDiv.innerHTML = '<p>Loading comparison…</p>';
    const { contents: parsedEntries, errors } = await getParsedContentsForFile(fileName);

    if (errors && errors.length) {
        alert('Issues reading some files:\n' + errors.join('\n'));
    }

    if (!parsedEntries || !parsedEntries.length) {
        resultsDiv.innerHTML = '<p>Unable to parse any annotator files for this selection.</p>';
        return;
    }

    fileContents = parsedEntries;
    const propertyKeys = collectPropertyKeys(fileContents);
    syncSelectedProperties(propertyKeys);
    const groups = buildGroups(fileContents);
    renderGroups(groups, fileContents, fileName, propertyKeys);
}

async function getParsedContentsForFile(fileName) {
    if (parsedAnnotationsByFile.has(fileName)) {
        return parsedAnnotationsByFile.get(fileName);
    }

    const entries = filesByAnnotation.get(fileName) || [];
    const parsedEntries = [];
    const errors = [];

    for (const entry of entries) {
        const cacheKey = `${entry.annotator}::${entry.path}`;
        let parsed = parsedCache.get(cacheKey);
        if (!parsed) {
            try {
                parsed = await parseAnnotationFile(entry);
                parsedCache.set(cacheKey, parsed);
            } catch (err) {
                console.error(err);
                errors.push(`${entry.annotator}: ${err.message}`);
                continue;
            }
        }
        parsedEntries.push(parsed);
    }

    const result = {
        contents: parsedEntries,
        errors
    };
    parsedAnnotationsByFile.set(fileName, result);
    return result;
}

async function ensureAllAnnotationsParsed() {
    const names = Array.from(filesByAnnotation.keys());
    for (const name of names) {
        if (!parsedAnnotationsByFile.has(name)) {
            await getParsedContentsForFile(name);
        }
    }
}

async function parseAnnotationFile({
    file,
    annotator,
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
        name: annotator,
        annotator,
        fileName: file.name,
        sourcePath: path,
        text: textEl.textContent,
        tags: Array.from(tagsEl.children).map(tag => {
            // if no spans attribute, skip this tag, or if its link
            if (!tag.hasAttribute('spans') || EXCLUDED_TAGS.has(tag.tagName.toLowerCase())) {
                return {
                    name: tag.tagName,
                    spans: [],
                    properties: {}
                };
            }
            const textAttr = tag.getAttribute('text') ?? '';
            const spanAttr = tag.getAttribute('spans') ?? '';
            const texts = textAttr.split('...');
            const spansAttr = spanAttr.split(',');
            if (texts.length !== spansAttr.length) throw new Error('Mismatch texts vs spans');
            const spans = spansAttr.map((s, idx) => {
                const [start, end] = s.split('~').map(n => parseInt(n, 10));
                if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Bad span');
                return {
                    start,
                    end,
                    text: texts[idx]
                };
            });
            const props = {};
            for (const at of tag.attributes) {
                if (['spans', 'text', 'id'].includes(at.name)) continue;
                props[at.name] = at.value;
            }
            return {
                name: tag.tagName,
                spans,
                properties: props
            };
        })
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

function buildGroups(contents) {
    const global = [];
    contents.forEach(fc => fc.spans.forEach(s => global.push(s)));
    global.sort((a, b) => a.start - b.start || a.end - b.end);
    const groups = [];
    let cur = [];
    for (const sp of global) {
        if (!cur.length || cur.some(c => sp.start < c.end)) {
            cur.push(sp);
        } else {
            groups.push(cur);
            cur = [sp];
        }
    }
    if (cur.length) groups.push(cur);
    return groups;
}


function renderGroups(groups, contents, selectedFileName, propertyKeys) {
    resultsDiv.innerHTML = '';
    const summaryBlock = createAgreementSummary(contents, selectedFileName, propertyKeys);
    resultsDiv.appendChild(summaryBlock);

    if (!groups.length) {
        const emptyMsg = document.createElement('p');
        emptyMsg.textContent = 'No tags were found in the selected annotation file.';
        resultsDiv.appendChild(emptyMsg);
        applyMode();
        return;
    }

    groups.forEach((group, gi) => {

        const merged = [];
        group.forEach(sp => {
            const ex = merged.find(m => m.start === sp.start && m.end === sp.end && m.text === sp.text && m.name === sp.name && shallowEqual(m.properties, sp.properties));
            if (ex) {
                ex.files.push({
                    label: sp.filename,
                    path: sp.originPath
                });
            } else {
                merged.push({
                    ...sp,
                    files: [{
                        label: sp.filename,
                        path: sp.originPath
                    }]
                });
            }
        });

        const differentProps = new Set();
        const propValues = group[0].properties;
        for (const sp of merged) {
            for (const [k, v] of Object.entries(sp.properties)) {
                if (propValues[k] !== v) {
                    differentProps.add(k);
                }
            }
        }

        const tagNames = new Set(merged.map(sp => sp.name));

        const gDiv = document.createElement('div');
        gDiv.className = 'group';
        const h3 = document.createElement('h3');
        h3.textContent = 'Group ' + (gi + 1);
        h3.dataset.spanCount = group.length + ' spans';
        gDiv.appendChild(h3);

        const description = document.createElement('p');
        const spansDiffer = merged.some(sp => sp.start !== group[0].start || sp.end !== group[0].end || sp.text !== group[0].text);
        const uniqueFiles = new Set(group.map(sp => sp.filename));

        if (uniqueFiles.size !== contents.length) {
            description.textContent = `Not all graders tagged this span. Found in: ${Array.from(uniqueFiles).join(', ')}. Not found in: ${contents.map(fc => fc.name).filter(name => !uniqueFiles.has(name)).join(', ')}.`;
            gDiv.classList.add('error-accent');
        } else if (merged.length === 1) {
            description.textContent = `Each grader found the same tag "${merged[0].name}" with identical properties. No ambiguity.`;
            gDiv.classList.add('good-accent');

        } else if (tagNames.size > 1) {
            description.textContent = `Multiple tag names found: ${Array.from(tagNames).join(', ')}. This indicates different tagging conventions or errors.`;
            gDiv.classList.add('error-accent');
        } else {
            if (differentProps.size === 0) {
                description.textContent = `All graders found the same tag "${merged[0].name}" but with different selections of text. Please review the selections.`;
            } else if (spansDiffer) {
                description.textContent = `All graders found the same tag "${merged[0].name}" but with different properties and text. Please review the differences.`;
            } else {
                description.textContent = `All graders found the same tag "${merged[0].name}" but with different properties. Please review the differences.`;
            }
            gDiv.classList.add('warning-accent');
        }

        gDiv.appendChild(description);

        const contextTitle = document.createElement('h5');
        contextTitle.textContent = '200 Character Context';
        gDiv.appendChild(contextTitle);

        const contextElement = document.createElement('div');
        contextElement.className = 'context';

        const contextStart = Math.max(group[0].start - 100, 0);
        const contextEnd = Math.min(group[group.length - 1].end + 100, contents[0].text.length);
        const contextText = contents[0].text.substring(contextStart, contextEnd);
        const contextGrid = document.createElement('span');
        contextGrid.className = 'whitespace-grid';
        contextGrid.dataset.raw = contextText;
        buildCharGridInto(contextGrid, contextText);
        contextElement.appendChild(contextGrid);
        gDiv.appendChild(contextElement);

        const header = document.createElement('h5');
        header.textContent = 'Tags:';
        gDiv.appendChild(header);

        const table = document.createElement('table');
        table.className = 'span-table';
        const head = document.createElement('tr');
        head.innerHTML = '<th>Files</th><th>Tag</th><th>Text</th><th>Span</th><th>Properties</th>';
        table.appendChild(head);

        merged.forEach(sp => {
            const tr = document.createElement('tr');
            const tdFiles = document.createElement('td');
            const tdFilesList = document.createElement('ul');
            tdFilesList.className = 'file-list';
            sp.files.forEach(f => {
                const fileSpan = document.createElement('li');
                fileSpan.textContent = f.label;
                fileSpan.className = 'file-name';
                fileSpan.title = f.path || f.label;
                tdFilesList.appendChild(fileSpan);
            });
            tdFiles.appendChild(tdFilesList);

            tr.appendChild(tdFiles);
            const tdTag = document.createElement('td');
            tdTag.textContent = sp.name;
            tdTag.classList.add('tag-' + sp.name);
            tr.appendChild(tdTag);
            const tdText = document.createElement('td');
            const grid = document.createElement('span');
            grid.className = 'whitespace-grid';
            grid.dataset.raw = sp.text;
            buildCharGridInto(grid, sp.text);
            tdText.appendChild(grid);
            tr.appendChild(tdText);
            const tdSpan = document.createElement('td');
            tdSpan.textContent = sp.start + '~' + sp.end;
            tr.appendChild(tdSpan);
            const tdProp = document.createElement('td');
            const ul = document.createElement('ul');
            ul.className = 'prop-list';
            for (const [k, v] of Object.entries(sp.properties)) {
                if (!v) continue;
                const li = document.createElement('li');
                li.textContent = k + ': ' + v;
                addPropClasses(li, k, v);
                if (differentProps.has(k)) li.classList.add('diff');
                ul.appendChild(li);
            }
            tdProp.appendChild(ul);
            tr.appendChild(tdProp);
            table.appendChild(tr);
        });

        gDiv.appendChild(table);
        resultsDiv.appendChild(gDiv);
    });
    applyMode();
}

function createAgreementSummary(contents, selectedFileName, propertyKeys) {
    const block = document.createElement('div');
    block.className = 'group summary-block';

    const heading = document.createElement('h3');
    heading.textContent = selectedFileName || 'Selected Annotation';
    heading.dataset.spanCount = `${contents.length} annotator${contents.length === 1 ? '' : 's'}`;
    block.appendChild(heading);

    const details = document.createElement('p');
    details.textContent = `Annotators loaded: ${contents.map(fc => fc.name).join(', ')}`;
    block.appendChild(details);

    if (contents.length < 2) {
        const note = document.createElement('small');
        note.className = 'summary-note';
        note.textContent = 'Load at least two annotators to compute inter-annotator agreement.';
        block.appendChild(note);
        return block;
    }

    const sliderId = `overlap-${Math.random().toString(36).slice(2, 8)}`;
    const controls = document.createElement('div');
    controls.className = 'summary-controls';

    const label = document.createElement('label');
    label.setAttribute('for', sliderId);
    label.textContent = 'Overlap threshold';
    controls.appendChild(label);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.05';
    slider.value = `${agreementThreshold}`;
    slider.id = sliderId;
    controls.appendChild(slider);

    const valueLabel = document.createElement('span');
    valueLabel.className = 'summary-threshold-value';
    valueLabel.textContent = formatPercentage(agreementThreshold, 0);
    controls.appendChild(valueLabel);

    block.appendChild(controls);

    const note = document.createElement('small');
    note.className = 'summary-note';
    block.appendChild(note);

    const overallSummary = document.createElement('p');
    overallSummary.className = 'summary-overall';
    overallSummary.style.margin = '0.35rem 0 0.75rem';
    overallSummary.style.fontWeight = '600';
    overallSummary.textContent = 'Overall F1: —';
    block.appendChild(overallSummary);

    const tagChartSection = document.createElement('div');
    tagChartSection.className = 'summary-tag-chart';

    const tagHeading = document.createElement('h4');
    tagHeading.textContent = 'Per tag F1';
    tagChartSection.appendChild(tagHeading);

    const tagChart = document.createElement('div');
    tagChart.className = 'tag-f1-chart';
    tagChartSection.appendChild(tagChart);

    block.appendChild(tagChartSection);

    const table = document.createElement('table');
    table.className = 'agreement-table';
    block.appendChild(table);

    const globalSection = document.createElement('div');
    globalSection.className = 'summary-global-block';
    globalSection.style.marginTop = '1.1rem';
    const globalHeading = document.createElement('h4');
    globalHeading.textContent = 'Whole dataset heatmap';
    globalHeading.style.margin = '0 0 0.35rem';
    globalHeading.style.fontSize = '0.92rem';
    globalHeading.style.fontWeight = '600';
    globalHeading.style.color = '#1b365d';
    globalSection.appendChild(globalHeading);

    const globalOverall = document.createElement('p');
    globalOverall.className = 'summary-overall';
    globalOverall.style.margin = '0 0 0.6rem';
    globalOverall.style.fontWeight = '600';
    globalOverall.textContent = 'Whole dataset F1: —';
    globalSection.appendChild(globalOverall);

    const globalTable = document.createElement('table');
    globalTable.className = 'agreement-table';
    globalSection.appendChild(globalTable);

    const globalTagHeading = document.createElement('h5');
    globalTagHeading.textContent = 'Whole dataset per tag F1';
    globalTagHeading.className = 'summary-global-tag-heading';
    globalSection.appendChild(globalTagHeading);

    const globalTagChart = document.createElement('div');
    globalTagChart.className = 'tag-f1-chart';
    globalSection.appendChild(globalTagChart);

    block.appendChild(globalSection);

    let renderToken = 0;

    async function renderTable() {
        const token = ++renderToken;
        const propsForMatching = (selectedMatchingProperties instanceof Set) ? new Set(selectedMatchingProperties) : new Set();
        const matrix = populateAgreementTable(table, contents, propsForMatching);
        note.textContent = buildMatchRequirementText(agreementThreshold, propsForMatching, propertyKeys);
        const totals = aggregatePairwiseMetrics(matrix);
        if (totals.pairs === 0) {
            overallSummary.textContent = 'Overall F1: n/a (not enough data)';
        } else {
            overallSummary.textContent = `Overall F1: ${formatScore(totals.f1)} (TP ${totals.tp} | FP ${totals.fp} | FN ${totals.fn})`;
        }
        if (selectedFileName) updateAnnotationOptionScore(selectedFileName, totals);

        const tagMetrics = computeTagWiseMetrics(contents, agreementThreshold, propsForMatching);
        renderTagF1Chart(tagChart, tagMetrics);

        const { annotators, matrix: globalMatrix, tagMetrics: globalTagMetrics } = await computeGlobalAgreementMatrix(propsForMatching);
        if (token !== renderToken) return;
        if (!annotators.length) {
            globalTable.innerHTML = '<tr><td>No overlapping annotator pairs across files.</td></tr>';
            globalOverall.textContent = 'Whole dataset F1: n/a (not enough data)';
        } else {
            renderAgreementTable(globalTable, annotators, globalMatrix);
            const globalTotals = aggregatePairwiseMetrics(globalMatrix);
            if (globalTotals.pairs === 0) {
                globalOverall.textContent = 'Whole dataset F1: n/a (not enough data)';
            } else {
                globalOverall.textContent = `Whole dataset F1: ${formatScore(globalTotals.f1)} (TP ${globalTotals.tp} | FP ${globalTotals.fp} | FN ${globalTotals.fn})`;
            }
        }

        renderTagF1Chart(globalTagChart, globalTagMetrics);

        await refreshFileOptionScores(propsForMatching);
    }

    const safeRender = () => {
        renderTable().catch(err => {
            console.error('Failed to render agreement tables', err);
            overallSummary.textContent = 'Overall F1: n/a (error)';
            globalOverall.textContent = 'Whole dataset F1: n/a (error)';
        });
    };

    if (!propertyKeys) propertyKeys = collectPropertyKeys(contents);
    syncSelectedProperties(propertyKeys);

    const propertyControls = createPropertyControls(propertyKeys, safeRender);
    if (propertyControls) {
        block.insertBefore(propertyControls, note);
    }

    slider.addEventListener('input', () => {
        agreementThreshold = parseFloat(slider.value);
        valueLabel.textContent = formatPercentage(agreementThreshold, 0);
        safeRender();
    });

    safeRender();

    return block;
}

function populateAgreementTable(table, contents, propertiesForMatching) {
    const annotators = contents.map(fc => fc.name);
    const matrix = computeAgreementMatrix(contents, agreementThreshold, propertiesForMatching);
    renderAgreementTable(table, annotators, matrix);
    return matrix;
}

function renderAgreementTable(table, annotators, matrix) {
    table.innerHTML = '';

    if (!annotators || !annotators.length) {
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.textContent = 'No annotators loaded.';
        row.appendChild(td);
        table.appendChild(row);
        return;
    }

    const headerRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.textContent = '';
    headerRow.appendChild(corner);
    annotators.forEach(name => {
        const th = document.createElement('th');
        th.textContent = name;
        headerRow.appendChild(th);
    });
    table.appendChild(headerRow);

    annotators.forEach((rowName, rowIdx) => {
        const tr = document.createElement('tr');
        const rowHeader = document.createElement('th');
        rowHeader.textContent = rowName;
        tr.appendChild(rowHeader);

        annotators.forEach((colName, colIdx) => {
            const td = document.createElement('td');

            if (rowIdx === colIdx) {
                td.textContent = '—';
                td.classList.add('diagonal');
                td.title = 'Same annotator';
            } else {
                const metrics = (matrix && matrix[rowIdx]) ? matrix[rowIdx][colIdx] : null;
                if (!metrics || (metrics.totalRow === 0 && metrics.totalColumn === 0)) {
                    td.textContent = 'n/a';
                    td.classList.add('empty');
                    td.title = 'Not enough data to compute score';
                } else {
                    const score = metrics.f1;
                    td.textContent = formatScore(score);
                    td.style.backgroundColor = heatmapColor(score);
                    td.style.color = score >= 0.8 ? '#0d3a1d' : (score <= 0.2 ? '#5b1a1a' : '#1f2e3c');
                    const totalRow = metrics.totalRow;
                    const totalCol = metrics.totalColumn;
                    const precision = totalRow === 0 ? 1 : metrics.tp / totalRow;
                    const recall = totalCol === 0 ? 1 : metrics.tp / totalCol;
                    const missedRow = totalRow - metrics.tp;
                    const missedCol = totalCol - metrics.tp;
                    td.title = [
                        `F1: ${formatScore(score)}`,
                        `Precision (${rowName}): ${formatScore(precision)}`,
                        `Recall vs ${colName}: ${formatScore(recall)}`,
                        `Matches: ${metrics.tp}`,
                        `Unmatched ${rowName}: ${missedRow}`,
                        `Unmatched ${colName}: ${missedCol}`
                    ].join(' | ');
                }
            }

            tr.appendChild(td);
        });

        table.appendChild(tr);
    });
}

function computeAgreementMatrix(contents, threshold, propertiesForMatching) {
    const len = contents.length;
    const matrix = Array.from({
        length: len
    }, () => Array(len).fill(null));

    for (let i = 0; i < len; i++) {
        for (let j = i + 1; j < len; j++) {
            const metrics = scorePair(contents[i], contents[j], threshold, propertiesForMatching);
            matrix[i][j] = {
                f1: metrics.f1,
                tp: metrics.tp,
                totalRow: metrics.totalA,
                totalColumn: metrics.totalB
            };
            matrix[j][i] = {
                f1: metrics.f1,
                tp: metrics.tp,
                totalRow: metrics.totalB,
                totalColumn: metrics.totalA
            };
        }
    }

    return matrix;
}

function aggregatePairwiseMetrics(matrix) {
    return aggregateMatrixTotals(matrix);
}

function aggregateMatrixTotals(matrix) {
    const totals = {
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        pairs: 0,
        f1: 0
    };

    if (!Array.isArray(matrix)) return totals;

    for (let i = 0; i < matrix.length; i++) {
        const row = matrix[i];
        if (!Array.isArray(row)) continue;
        for (let j = i + 1; j < row.length; j++) {
            const entry = row[j];
            if (!entry) continue;
            const pairTp = entry.tp ?? 0;
            const totalRow = entry.totalRow ?? 0;
            const totalColumn = entry.totalColumn ?? 0;
            totals.tp += pairTp;
            totals.fp += Math.max(0, totalRow - pairTp);
            totals.fn += Math.max(0, totalColumn - pairTp);
            totals.tn += Math.max(0, entry.tn ?? 0);
            totals.pairs += 1;
        }
    }

    const denom = (2 * totals.tp) + totals.fp + totals.fn;
    totals.f1 = denom === 0 ? 1 : (2 * totals.tp) / denom;

    return totals;
}

function normalizePropsSet(propertiesForMatching) {
    if (propertiesForMatching instanceof Set) return new Set(propertiesForMatching);
    if (Array.isArray(propertiesForMatching)) return new Set(propertiesForMatching);
    if (!propertiesForMatching) return new Set();
    return new Set(Array.from(propertiesForMatching));
}

function computeTagWiseMetrics(contents, threshold, propertiesForMatching) {
    if (!Array.isArray(contents) || contents.length < 2) return [];
    const propsSet = normalizePropsSet(propertiesForMatching);

    const grouped = contents.map(fc => {
        const tagMap = new Map();
        (fc.spans || []).forEach(span => {
            if (!tagMap.has(span.name)) tagMap.set(span.name, []);
            tagMap.get(span.name).push(span);
        });
        return tagMap;
    });

    const tagNames = new Set();
    grouped.forEach(map => {
        map.forEach((_, tag) => tagNames.add(tag));
    });

    const results = [];
    Array.from(tagNames)
        .sort((a, b) => a.localeCompare(b, undefined, {
            sensitivity: 'base'
        }))
        .forEach(tag => {
            const totals = {
                tag,
                tp: 0,
                fp: 0,
                fn: 0,
                pairs: 0,
                f1: 0
            };

            for (let i = 0; i < contents.length; i++) {
                for (let j = i + 1; j < contents.length; j++) {
                    const annotA = {
                        spans: grouped[i].get(tag) || []
                    };
                    const annotB = {
                        spans: grouped[j].get(tag) || []
                    };
                    const metrics = scorePair(annotA, annotB, threshold, propsSet);
                    const pairTp = metrics.tp;
                    const totalA = metrics.totalA;
                    const totalB = metrics.totalB;
                    totals.tp += pairTp;
                    totals.fp += Math.max(0, totalA - pairTp);
                    totals.fn += Math.max(0, totalB - pairTp);
                    totals.pairs += 1;
                }
            }

            const denom = (2 * totals.tp) + totals.fp + totals.fn;
            totals.f1 = denom === 0 ? 1 : (2 * totals.tp) / denom;
            if (totals.tp + totals.fp + totals.fn > 0) {
                results.push(totals);
            }
        });

    return results.sort((a, b) => {
        if (b.f1 === a.f1) return a.tag.localeCompare(b.tag, undefined, {
            sensitivity: 'base'
        });
        return b.f1 - a.f1;
    });
}

function renderTagF1Chart(container, metrics) {
    if (!container) return;
    container.innerHTML = '';

    if (!Array.isArray(metrics) || !metrics.length) {
        const empty = document.createElement('span');
        empty.textContent = 'No tag-level metrics available.';
        empty.style.fontSize = '.8rem';
        empty.style.color = '#5a6b7d';
        container.appendChild(empty);
        return;
    }

    metrics.forEach(metric => {
        const row = document.createElement('div');
        row.className = 'tag-f1-row';

        const label = document.createElement('span');
        label.className = 'tag-f1-label';
        label.textContent = metric.tag;
        row.appendChild(label);

        const barWrapper = document.createElement('div');
        barWrapper.className = 'tag-f1-bar';

        const bar = document.createElement('div');
        bar.className = 'tag-f1-bar-fill';
        const width = Math.max(0, Math.min(1, metric.f1)) * 100;
        bar.style.width = `${width.toFixed(0)}%`;
        bar.style.backgroundColor = heatmapColor(metric.f1);
        barWrapper.appendChild(bar);

        row.appendChild(barWrapper);

        const stats = document.createElement('span');
        stats.className = 'tag-f1-stats';
        stats.textContent = `F1 ${formatScore(metric.f1)} | TP ${metric.tp} | FP ${metric.fp} | FN ${metric.fn}`;
        row.appendChild(stats);

        container.appendChild(row);
    });
}

async function computeGlobalAgreementMatrix(propertiesForMatching) {
    const propsSet = normalizePropsSet(propertiesForMatching);
    await ensureAllAnnotationsParsed();

    const annotatorNames = new Set();
    parsedAnnotationsByFile.forEach(({
        contents
    }) => {
        (contents || []).forEach(fc => annotatorNames.add(fc.name));
    });

    const annotators = Array.from(annotatorNames).sort((a, b) => a.localeCompare(b, undefined, {
        sensitivity: 'base'
    }));
    const len = annotators.length;
    const matrix = Array.from({
        length: len
    }, () => Array(len).fill(null));

    for (let i = 0; i < len; i++) {
        for (let j = i + 1; j < len; j++) {
            let tp = 0;
            let totalA = 0;
            let totalB = 0;
            let hasData = false;

            parsedAnnotationsByFile.forEach(({
                contents
            }) => {
                if (!contents || contents.length < 2) return;
                let annotA = null;
                let annotB = null;
                for (const entry of contents) {
                    if (!annotA && entry.name === annotators[i]) annotA = entry;
                    if (!annotB && entry.name === annotators[j]) annotB = entry;
                    if (annotA && annotB) break;
                }
                if (!annotA || !annotB) return;
                const metrics = scorePair(annotA, annotB, agreementThreshold, propsSet);
                tp += metrics.tp;
                totalA += metrics.totalA;
                totalB += metrics.totalB;
                hasData = true;
            });

            if (hasData) {
                const denom = (2 * tp) + Math.max(0, totalA - tp) + Math.max(0, totalB - tp);
                const f1 = denom === 0 ? 1 : (2 * tp) / denom;
                matrix[i][j] = {
                    f1,
                    tp,
                    totalRow: totalA,
                    totalColumn: totalB
                };
                matrix[j][i] = {
                    f1,
                    tp,
                    totalRow: totalB,
                    totalColumn: totalA
                };
            }
        }
    }

    const tagMetrics = computeGlobalTagMetrics(propsSet);

    return {
        annotators,
        matrix,
        tagMetrics
    };
}

function computeGlobalTagMetrics(propsSet) {
    const totalsByTag = new Map();

    parsedAnnotationsByFile.forEach(({
        contents
    }) => {
        if (!contents || contents.length < 2) return;
        const metrics = computeTagWiseMetrics(contents, agreementThreshold, propsSet);
        metrics.forEach(({ tag, tp, fp, fn }) => {
            if (!totalsByTag.has(tag)) {
                totalsByTag.set(tag, {
                    tag,
                    tp: 0,
                    fp: 0,
                    fn: 0
                });
            }
            const aggregate = totalsByTag.get(tag);
            aggregate.tp += tp;
            aggregate.fp += fp;
            aggregate.fn += fn;
        });
    });

    const results = Array.from(totalsByTag.values()).map(entry => {
        const denom = (2 * entry.tp) + entry.fp + entry.fn;
        return {
            tag: entry.tag,
            tp: entry.tp,
            fp: entry.fp,
            fn: entry.fn,
            f1: denom === 0 ? 1 : (2 * entry.tp) / denom
        };
    });

    return results.sort((a, b) => {
        if (b.f1 === a.f1) return a.tag.localeCompare(b.tag, undefined, {
            sensitivity: 'base'
        });
        return b.f1 - a.f1;
    });
}

async function refreshFileOptionScores(propertiesForMatching) {
    const token = ++optionRefreshToken;
    const propsSet = normalizePropsSet(propertiesForMatching);
    await ensureAllAnnotationsParsed();
    if (token !== optionRefreshToken) return;

    for (const fileName of filesByAnnotation.keys()) {
        const { contents } = await getParsedContentsForFile(fileName);
        if (!contents || contents.length < 2) {
            updateAnnotationOptionScore(fileName, null);
            continue;
        }
        const matrix = computeAgreementMatrix(contents, agreementThreshold, propsSet);
        const totals = aggregatePairwiseMetrics(matrix);
        updateAnnotationOptionScore(fileName, totals);
        if (token !== optionRefreshToken) return;
    }
}

function updateAnnotationOptionScore(fileName, totals) {
    if (!fileName) return;
    const option = Array.from(annotationSelect.options).find(opt => opt.value === fileName);
    if (!option) return;
    const baseLabel = option.dataset.baseLabel || option.textContent || fileName;
    let suffix = 'F1 n/a';
    if (totals && totals.pairs > 0 && Number.isFinite(totals.f1)) {
        suffix = `F1 ${formatScore(totals.f1)}`;
    }
    option.textContent = `${baseLabel} — ${suffix}`;
    option.dataset.score = suffix;
}

function scorePair(annotatorA, annotatorB, threshold, propertiesForMatching) {
    const spansA = annotatorA.spans || [];
    const spansB = annotatorB.spans || [];
    const usedB = new Set();
    let tp = 0;
    let fp = 0;

    spansA.forEach(spanA => {
        let bestIdx = -1;
        let bestOverlap = 0;

        spansB.forEach((spanB, idx) => {
            if (usedB.has(idx)) return;
            if (spanA.name !== spanB.name) return;
            if (!propertiesMatch(spanA, spanB, propertiesForMatching)) return;

            const overlap = calculateSpanOverlap(spanA, spanB);
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestIdx = idx;
            }
        });

        if (bestIdx !== -1 && bestOverlap >= threshold) {
            usedB.add(bestIdx);
            tp += 1;
        } else {
            fp += 1;

            // if (bestIdx !== -1) {
            //     usedB.add(bestIdx);
            // }
        }
    });

    const totalA = spansA.length;
    const totalB = spansB.length;
    const unmatchedA = fp;
    const unmatchedB = totalB - usedB.size;
    const denom = (2 * tp) + unmatchedA + unmatchedB;
    const f1 = denom === 0 ? 1 : (2 * tp) / denom;
    const precision = (tp + unmatchedA) === 0 ? 1 : tp / (tp + unmatchedA);
    const recall = (tp + unmatchedB) === 0 ? 1 : tp / (tp + unmatchedB);

    return {
        tp,
        unmatchedA,
        unmatchedB,
        totalA,
        totalB,
        f1,
        precision,
        recall
    };
}

function calculateSpanOverlap(spanA, spanB) {
    const intersectionStart = Math.max(spanA.start, spanB.start);
    const intersectionEnd = Math.min(spanA.end, spanB.end);
    const intersection = Math.max(0, intersectionEnd - intersectionStart);
    const unionStart = Math.min(spanA.start, spanB.start);
    const unionEnd = Math.max(spanA.end, spanB.end);
    const union = Math.max(0, unionEnd - unionStart);
    if (union === 0) return 0;
    return intersection / union;
}

function formatPercentage(value, digits = 1) {
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(digits)}%`;
}

function formatScore(score) {
    return formatPercentage(score, 1);
}

function heatmapColor(score) {
    if (!Number.isFinite(score)) return '#f9fbfe';
    const clamped = Math.max(0, Math.min(1, score));
    const hue = clamped * 120; // 0 = red, 120 = green
    const saturation = 70;
    const lightness = 90 - (clamped * 35);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function shallowEqual(a, b) {
    const ka = Object.keys(a),
        kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka)
        if (a[k] !== b[k]) return false;
    return true;
}

function collectPropertyKeys(contents) {
    const keys = new Set();
    contents.forEach(fc => {
        (fc.spans || []).forEach(span => {
            Object.keys(span.properties || {}).forEach(k => keys.add(k));
        });
    });
    return Array.from(keys).sort((a, b) => a.localeCompare(b, undefined, {
        sensitivity: 'base'
    }));
}

function syncSelectedProperties(propertyKeys) {
    const keys = Array.isArray(propertyKeys) ? propertyKeys : [];
    const available = new Set(keys);
    Array.from(selectedMatchingProperties).forEach(key => {
        if (!available.has(key)) {
            selectedMatchingProperties.delete(key);
        }
    });
    if (!propertySelectionTouched && keys.length) {
        selectedMatchingProperties.clear();
        keys.forEach(key => selectedMatchingProperties.add(key));
    }
    if (!keys.length && !propertySelectionTouched) {
        selectedMatchingProperties.clear();
    }
}

function createPropertyControls(propertyKeys, onChange) {
    if (!propertyKeys || !propertyKeys.length) return null;
    const refresh = (typeof onChange === 'function') ? onChange : () => {};
    const wrapper = document.createElement('div');
    wrapper.className = 'summary-property-controls';

    const legend = document.createElement('div');
    legend.className = 'summary-property-label';
    legend.textContent = 'Match on properties:';
    legend.style.fontWeight = '600';
    legend.style.marginBottom = '0.35rem';
    wrapper.appendChild(legend);

    const options = document.createElement('div');
    options.className = 'summary-property-options';
    options.style.display = 'flex';
    options.style.flexWrap = 'wrap';
    wrapper.appendChild(options);

    const checkboxes = [];
    const idSuffix = Math.random().toString(36).slice(2, 8);

    propertyKeys.forEach((key, idx) => {
        const optionLabel = document.createElement('label');
        optionLabel.className = 'summary-property-option';
        optionLabel.style.display = 'inline-flex';
        optionLabel.style.alignItems = 'center';
        optionLabel.style.marginRight = '0.75rem';
        optionLabel.style.marginBottom = '0.4rem';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `match-prop-${idx}-${idSuffix}`;
        checkbox.value = key;
        checkbox.checked = selectedMatchingProperties.has(key);
        checkbox.addEventListener('change', () => {
            propertySelectionTouched = true;
            if (checkbox.checked) {
                selectedMatchingProperties.add(key);
            } else {
                selectedMatchingProperties.delete(key);
            }
            refresh();
        });

        const text = document.createElement('span');
        text.textContent = key;
        text.style.marginLeft = '0.35rem';

        optionLabel.appendChild(checkbox);
        optionLabel.appendChild(text);
        options.appendChild(optionLabel);
        checkboxes.push(checkbox);
    });

    const actions = document.createElement('div');
    actions.className = 'summary-property-actions';
    actions.style.marginTop = '0.35rem';
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';

    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.textContent = 'Select all';
    selectAllBtn.style.fontSize = '0.85rem';
    selectAllBtn.style.padding = '0.2rem 0.5rem';
    selectAllBtn.addEventListener('click', () => {
        propertySelectionTouched = true;
        propertyKeys.forEach(key => selectedMatchingProperties.add(key));
        checkboxes.forEach(cb => {
            cb.checked = true;
        });
        refresh();
    });
    actions.appendChild(selectAllBtn);

    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.textContent = 'Clear all';
    clearAllBtn.style.marginLeft = '0.5rem';
    clearAllBtn.style.fontSize = '0.85rem';
    clearAllBtn.style.padding = '0.2rem 0.5rem';
    clearAllBtn.addEventListener('click', () => {
        propertySelectionTouched = true;
        selectedMatchingProperties.clear();
        checkboxes.forEach(cb => {
            cb.checked = false;
        });
        refresh();
    });
    actions.appendChild(clearAllBtn);

    wrapper.appendChild(actions);

    return wrapper;
}

function buildMatchRequirementText(threshold, propsSet, availableKeys) {
    const overlapText = `Matches require spans to overlap by at least ${formatPercentage(threshold, 0)}`;
    if (!propsSet || propsSet.size === 0) {
        if (Array.isArray(availableKeys) && availableKeys.length) {
            return `${overlapText} (properties ignored).`;
        }
        return `${overlapText}.`;
    }
    const list = Array.from(propsSet).join(', ');
    return `${overlapText} and match selected properties (${list}).`;
}

function propertiesMatch(spanA, spanB, propsSet) {
    if (!propsSet || propsSet.size === 0) return true;
    const aProps = spanA.properties || {};
    const bProps = spanB.properties || {};
    for (const key of propsSet) {
        const valA = aProps[key] ?? '';
        const valB = bProps[key] ?? '';
        if (valA !== valB) return false;
    }
    return true;
}

function buildCharGridInto(container, text) {
    container.innerHTML = '';
    const len = text.length;
    const leadingSpace = text.startsWith(' ');
    const trailingSpace = text.endsWith(' ') && !/\n$/.test(text);

    for (let i = 0; i < len; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '\r' && next === '\n') {
            container.appendChild(mkSpan('crlf', RAW.lf, RAW.crlf));
            container.appendChild(document.createElement('br'));
            i++;
            continue;
        }
        if (ch === '\r') {
            container.appendChild(mkSpan('cr', RAW.lf, RAW.cr));
            continue;
        }
        if (ch === '\n') {

            container.appendChild(mkSpan('lf', RAW.lf, RAW.lf));
            container.appendChild(document.createElement('br'));
            continue;
        }
        if (ch === '\t') {
            container.appendChild(mkSpan('tab', RAW.tab, RAW.tab));
            continue;
        }
        if (ch === '\u00A0') {
            container.appendChild(mkSpan('nbsp', RAW.nbsp, RAW.nbsp));
            continue;
        }
        if (ch === ' ') {
            container.appendChild(mkSpan('space', RAW.space, RAW.space));
            continue;
        }
        container.appendChild(mkSpan('vis', ch, ch));
    }

    if (leadingSpace && container.firstChild) container.firstChild.classList.add('leading');
    if (trailingSpace) {
        for (let j = container.childNodes.length - 1; j >= 0; j--) {
            const n = container.childNodes[j];
            if (n.classList && n.classList.contains('space')) {
                n.classList.add('trailing');
                break;
            }
            if (n.classList && (n.classList.contains('lf') || n.classList.contains('crlf') || n.classList.contains('cr'))) break;
        }
    }
}

function mkSpan(type, displayChar, orig) {
    const s = document.createElement('span');
    if (type === 'vis') {
        s.className = 'ch vis';
        s.textContent = displayChar;
    } else {
        s.className = 'ch ws ' + type;
        s.dataset.type = type;
        s.textContent = displayChar;
    }
    s.dataset.orig = orig;
    return s;
}

function addPropClasses(el, key, value) {
    const k = key.toLowerCase();
    const v = (value || '').toLowerCase();
    el.classList.add('prop-' + k + '-' + v.replace(/[^a-z0-9]+/g, ''));
    if (/fall/.test(v) || /safety/.test(v)) el.classList.add('prop-fall-risk');
    if (/agitation|restless|anxious/.test(v)) el.classList.add('prop-agitation');
}

function applyMode() {
    document.body.className = 'mode-' + modeSelect.value;
    adjustSymbols();
}
modeSelect.addEventListener('change', applyMode);
showNlChk.addEventListener('change', () => {
    rebuildGrids();
});

function rebuildGrids() {
    document.querySelectorAll('.whitespace-grid').forEach(grid => {
        buildCharGridInto(grid, grid.dataset.raw);
    });
    adjustSymbols();
}

function adjustSymbols() {
    const mode = modeSelect.value;
    const showNl = showNlChk.checked;
    document.querySelectorAll('.whitespace-grid .ch.ws').forEach(span => {
        const type = span.dataset.type;
        if (!type) return;

        if (mode === 'normal') {

            span.textContent = (type === 'crlf') ? RAW.lf : RAW[type] || span.dataset.orig;
            span.classList.remove('show-symbol');
            span.style.opacity = '';
            return;
        }

        if ((type === 'lf' || type === 'cr' || type === 'crlf') && !showNl) {
            span.textContent = RAW.lf;
            span.classList.remove('show-symbol');
            span.style.opacity = '';
            return;
        }

        let marker;
        switch (type) {
            case 'space':
                marker = MARKERS.space;
                break;
            case 'nbsp':
                marker = MARKERS.nbsp;
                break;
            case 'tab':
                marker = MARKERS.tab;
                break;
            case 'lf':
                marker = MARKERS.lf;
                break;
            case 'cr':
                marker = MARKERS.cr;
                break;
            case 'crlf':
                marker = MARKERS.crlf;
                break;
            default:
                marker = span.dataset.orig;
        }
        span.textContent = marker;
        span.classList.add('show-symbol');
        span.style.opacity = (mode === 'reveal') ? '.55' : '1';
    });
}

applyMode();
