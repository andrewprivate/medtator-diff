const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const resultsDiv = document.getElementById('diffresults');
const modeSelect = document.getElementById('modeSelect');
const showNlChk = document.getElementById('showNewline');

let files = [], fileContents = [];

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

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { files.push(...e.target.files); update(); });
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === 'drop') { files.push(...e.dataTransfer.files); update(); }
    dropZone.classList.remove('dragover');
}));

async function update() {
    for (let i = fileContents.length; i < files.length; i++) {
        try {
            const content = await readFile(files[i]);
            const xmlDoc = new DOMParser().parseFromString(content, 'application/xml');
            if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML');
            const textEl = xmlDoc.querySelector('TEXT'); if (!textEl) throw new Error('Missing TEXT');
            const tagsEl = xmlDoc.querySelector('TAGS'); if (!tagsEl) throw new Error('Missing TAGS');
            const obj = {
                name: files[i].name,
                text: textEl.textContent,
                tags: Array.from(tagsEl.children).map(tag => {
                    const texts = tag.getAttribute('text').split('...');
                    const spansAttr = tag.getAttribute('spans').split(',');
                    if (texts.length !== spansAttr.length) throw new Error('Mismatch texts vs spans');
                    const spans = spansAttr.map((s, idx) => {
                        const [start, end] = s.split('~').map(n => parseInt(n, 10));
                        if (isNaN(start) || isNaN(end)) throw new Error('Bad span');
                        return { start, end, text: texts[idx] };
                    });
                    const props = {};
                    for (const at of tag.attributes) {
                        if (['spans', 'text', 'id'].includes(at.name)) continue;
                        props[at.name] = at.value;
                    }
                    return { name: tag.tagName, spans, properties: props };
                })
            };
            obj.spans = [];
            obj.tags.forEach(t => t.spans.forEach(sp => obj.spans.push({ start: sp.start, end: sp.end, text: sp.text, properties: t.properties, filename: obj.name, name: t.name })));
            obj.spans.sort((a, b) => a.start - b.start || a.end - b.end);
            fileContents.push(obj);
        } catch (e) {
            console.error(e);
            alert('Error reading ' + files[i].name + ': ' + e.message);
        }
    }
    if (!fileContents.length) return;
    const global = [];
    fileContents.forEach(fc => fc.spans.forEach(s => global.push(s)));
    global.sort((a, b) => a.start - b.start || a.end - b.end);
    const groups = []; let cur = [];
    for (const sp of global) {
        if (!cur.length || cur.some(c => sp.start <= c.end)) {
            cur.push(sp);
        } else { 
            groups.push(cur); cur = [sp]; 
        }
    }
    if (cur.length) groups.push(cur);
    renderGroups(groups);
}

function renderGroups(groups) {
    resultsDiv.innerHTML = '';
    groups.forEach((group, gi) => {

        const merged = [];
        group.forEach(sp => {
            const ex = merged.find(m => m.start === sp.start && m.end === sp.end && m.text === sp.text && m.name === sp.name && shallowEqual(m.properties, sp.properties));
            if (ex) ex.files.push(sp.filename); else merged.push({ ...sp, files: [sp.filename] });
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

        const gDiv = document.createElement('div'); gDiv.className = 'group';
        const h3 = document.createElement('h3');
        h3.textContent = 'Group ' + (gi + 1); h3.dataset.spanCount = group.length + ' spans'; gDiv.appendChild(h3);

        const description = document.createElement('p');
        const spansDiffer = merged.some(sp => sp.start !== group[0].start || sp.end !== group[0].end || sp.text !== group[0].text);
        const uniqueFiles = new Set(group.map(sp => sp.filename));

        if (uniqueFiles.size !== fileContents.length) {
            description.textContent = `Not all graders tagged this span. Found in: ${Array.from(uniqueFiles).join(', ')}. Not found in: ${fileContents.map(fc => fc.name).filter(name => !uniqueFiles.has(name)).join(', ')}.`;
            gDiv.classList.add('error-accent');
        }

        else if (merged.length === 1) {
            description.textContent = `Each grader found the same tag "${merged[0].name}" with identical properties. No ambiguity.`;
            gDiv.classList.add('good-accent');

        }

        else if (tagNames.size > 1) {
            description.textContent = `Multiple tag names found: ${Array.from(tagNames).join(', ')}. This indicates different tagging conventions or errors.`;
            gDiv.classList.add('error-accent');
        }

        else {
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

        const contextStart = Math.max(group[0].start - 100, 0)
        const contextEnd = Math.min(group[group.length - 1].end + 100, fileContents[0].text.length);
        const contextText = fileContents[0].text.substring(contextStart, contextEnd);
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
        const head = document.createElement('tr'); head.innerHTML = '<th>Files</th><th>Tag</th><th>Text</th><th>Span</th><th>Properties</th>'; table.appendChild(head);

        merged.forEach(sp => {
            const tr = document.createElement('tr');
            const tdFiles = document.createElement('td');
            const tdFilesList = document.createElement('ul');
            tdFilesList.className = 'file-list';
            sp.files.forEach(f => {
                const fileSpan = document.createElement('li');
                fileSpan.textContent = f;
                fileSpan.className = 'file-name';
                fileSpan.title = f;
                tdFilesList.appendChild(fileSpan);
            });
            tdFiles.appendChild(tdFilesList);

            tr.appendChild(tdFiles);
            const tdTag = document.createElement('td'); tdTag.textContent = sp.name; tdTag.classList.add('tag-' + sp.name); tr.appendChild(tdTag);
            const tdText = document.createElement('td'); const grid = document.createElement('span'); grid.className = 'whitespace-grid'; grid.dataset.raw = sp.text; buildCharGridInto(grid, sp.text); tdText.appendChild(grid); tr.appendChild(tdText);
            const tdSpan = document.createElement('td'); tdSpan.textContent = sp.start + '~' + sp.end; tr.appendChild(tdSpan);
            const tdProp = document.createElement('td'); const ul = document.createElement('ul'); ul.className = 'prop-list';
            for (const [k, v] of Object.entries(sp.properties)) {
                if (!v) continue;
                const li = document.createElement('li');
                li.textContent = k + ': ' + v;
                addPropClasses(li, k, v);
                if (differentProps.has(k)) li.classList.add('diff');
                ul.appendChild(li);
            }
            tdProp.appendChild(ul); tr.appendChild(tdProp);
            table.appendChild(tr);
        });

        gDiv.appendChild(table); resultsDiv.appendChild(gDiv);
    });
    applyMode();
}

function shallowEqual(a, b) { const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false; for (const k of ka) if (a[k] !== b[k]) return false; return true; }

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
            i++; continue;
        }
        if (ch === '\r') { container.appendChild(mkSpan('cr', RAW.lf, RAW.cr)); continue; }
        if (ch === '\n') {

            container.appendChild(mkSpan('lf', RAW.lf, RAW.lf));
            container.appendChild(document.createElement('br'));
            continue;
        }
        if (ch === '\t') { container.appendChild(mkSpan('tab', RAW.tab, RAW.tab)); continue; }
        if (ch === '\u00A0') { container.appendChild(mkSpan('nbsp', RAW.nbsp, RAW.nbsp)); continue; }
        if (ch === ' ') { container.appendChild(mkSpan('space', RAW.space, RAW.space)); continue; }
        container.appendChild(mkSpan('vis', ch, ch));
    }

    if (leadingSpace && container.firstChild) container.firstChild.classList.add('leading');
    if (trailingSpace) {
        for (let j = container.childNodes.length - 1; j >= 0; j--) {
            const n = container.childNodes[j];
            if (n.classList && n.classList.contains('space')) { n.classList.add('trailing'); break; }
            if (n.classList && (n.classList.contains('lf') || n.classList.contains('crlf') || n.classList.contains('cr'))) break;
        }
    }
}

function mkSpan(type, displayChar, orig) {
    const s = document.createElement('span');
    if (type === 'vis') { s.className = 'ch vis'; s.textContent = displayChar; }
    else { s.className = 'ch ws ' + type; s.dataset.type = type; s.textContent = displayChar; }
    s.dataset.orig = orig;
    return s;
}

function addPropClasses(el, key, value) { const k = key.toLowerCase(); const v = (value || '').toLowerCase(); el.classList.add('prop-' + k + '-' + v.replace(/[^a-z0-9]+/g, '')); if (/fall/.test(v) || /safety/.test(v)) el.classList.add('prop-fall-risk'); if (/agitation|restless|anxious/.test(v)) el.classList.add('prop-agitation'); }

function applyMode() { document.body.className = 'mode-' + modeSelect.value; adjustSymbols(); }
modeSelect.addEventListener('change', applyMode);
showNlChk.addEventListener('change', () => { rebuildGrids(); });

function rebuildGrids() { document.querySelectorAll('.whitespace-grid').forEach(grid => { buildCharGridInto(grid, grid.dataset.raw); }); adjustSymbols(); }

function adjustSymbols() {
    const mode = modeSelect.value;
    const showNl = showNlChk.checked;
    document.querySelectorAll('.whitespace-grid .ch.ws').forEach(span => {
        const type = span.dataset.type; if (!type) return;

        if (mode === 'normal') {

            span.textContent = (type === 'crlf') ? RAW.lf : RAW[type] || span.dataset.orig;
            span.classList.remove('show-symbol'); span.style.opacity = ''; return;
        }

        if ((type === 'lf' || type === 'cr' || type === 'crlf') && !showNl) {
            span.textContent = RAW.lf; 
            span.classList.remove('show-symbol'); span.style.opacity = ''; return;
        }

        let marker;
        switch (type) {
            case 'space': marker = MARKERS.space; break;
            case 'nbsp': marker = MARKERS.nbsp; break;
            case 'tab': marker = MARKERS.tab; break;
            case 'lf': marker = MARKERS.lf; break;
            case 'cr': marker = MARKERS.cr; break;
            case 'crlf': marker = MARKERS.crlf; break;
            default: marker = span.dataset.orig;
        }
        span.textContent = marker;
        span.classList.add('show-symbol');
        span.style.opacity = (mode === 'reveal') ? '.55' : '1';
    });
}

applyMode();
