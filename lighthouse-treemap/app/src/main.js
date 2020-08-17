/**
 * Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @type {TreemapViewer} */
let treemapViewer;

// TODO: duplicate js modules should be within x% bytes in size of each other...

// TODO: use the full URL to shorten names?
// if (id.startsWith(origin)) id = id.replace(origin, '/');

// TODO: applyMutations option?

// TODO: unused bytes of inline scripts?

/**
 * @param {Treemap.Node} node
 * @param {(node: Treemap.Node, fullId: string) => void} fn
 */
function dfs(node, fn, fullId = '') {
  fullId = fullId ? `${fullId}/${node.name}` : node.name;
  fn(node, fullId);
  if (node.children) {
    for (const child of node.children) {
      dfs(child, fn, fullId);
    }
  }
}

class TreemapViewer {
  /**
   * @param {Treemap.Options} options
   * @param {HTMLElement} el
   */
  constructor(options, el) {
    const treemapDebugData = /** @type {LH.Audit.Details.DebugData} */ (
      options.lhr.audits['treemap-data'].details);
    if (!treemapDebugData || !treemapDebugData.treemapData) throw new Error('missing treemap-data');
    /** @type {import('../../../lighthouse-core/audits/treemap-data').TreemapData} */
    const treemapData = treemapDebugData.treemapData;

    /** @type {WeakMap<Treemap.Node, Treemap.RootNode>} */
    this.nodeToRootNodeMap = new WeakMap();

    for (const rootNodes of Object.values(treemapData)) {
      for (const rootNode of rootNodes) {
        dfs(rootNode.node, node => this.nodeToRootNodeMap.set(node, rootNode));
      }
    }

    this.mode = options.mode;
    this.treemapData = treemapData;
    /** @type {Treemap.Node | null} */
    this.currentRootNode = null;
    this.documentUrl = options.lhr.requestedUrl;
    this.el = el;
    this.getHue = Util.stableHasher(Util.COLOR_HUES);
  }

  /**
   * @param {string} id
   */
  findRootNode(id) {
    for (const rootNodes of Object.values(this.treemapData)) {
      for (const rootNode of rootNodes) {
        if (rootNode.name === id) return rootNode;
      }
    }
  }

  initListeners() {
    window.addEventListener('resize', () => {
      this.render();
    });

    window.addEventListener('click', (e) => {
      const nodeEl = e.target.closest('.webtreemap-node');
      if (!nodeEl) return;
      this.updateColors();
    });

    window.addEventListener('mouseover', (e) => {
      const nodeEl = e.target.closest('.webtreemap-node');
      if (!nodeEl) return;
      nodeEl.classList.add('webtreemap-node--hover');
    });

    window.addEventListener('mouseout', (e) => {
      const nodeEl = e.target.closest('.webtreemap-node'); Util.COLOR_HUES;
      if (!nodeEl) return;
      nodeEl.classList.remove('webtreemap-node--hover');
    });
  }

  /**
   * @param {Treemap.Mode} mode
   */
  show(mode) {
    this.mode = mode;
    if (!this.mode.partitionBy) this.mode.partitionBy = 'resourceBytes';

    // Update options view.
    const partitionBySelectorEl = Util.find('.partition-selector');
    partitionBySelectorEl.value = mode.partitionBy;

    if (mode.selector.type === 'group') {
      const rootNodes = this.treemapData[mode.selector.value];

      const children = rootNodes.map(rootNode => {
        // TODO: keep?
        // Wrap with the name of the rootNode. Only for bundles.
        if (rootNode.node.children) {
          return {
            name: rootNode.name,
            // idHash: rootNode.node.idHash,
            children: [rootNode.node],
            resourceBytes: rootNode.node.resourceBytes,
            unusedBytes: rootNode.node.unusedBytes,
            executionTime: rootNode.node.executionTime,
          };
        }

        return rootNode.node;
      });

      this.currentRootNode = {
        name: this.documentUrl,
        resourceBytes: children.reduce((acc, cur) => cur.resourceBytes + acc, 0),
        unusedBytes: children.reduce((acc, cur) => (cur.unusedBytes || 0) + acc, 0),
        executionTime: children.reduce((acc, cur) => (cur.executionTime || 0) + acc, 0),
        children,
      };
      createViewModes(rootNodes, mode);
      this.createTable(rootNodes);
    } else if (mode.selector.type === 'rootNodeId') {
      const rootNode = this.findRootNode(mode.selector.value);
      if (!rootNode) throw new Error('unknown root node');

      this.currentRootNode = rootNode.node;
      createViewModes([rootNode], mode);
      this.createTable([rootNode]);
    } else {
      throw new Error('invalid mode selector');
    }

    dfs(this.currentRootNode, node => {
      // @ts-ignore: webtreemap will store `dom` on the data to speed up operations.
      // However, when we change the underlying data representation, we need to delete
      // all the cached DOM elements. Otherwise, the rendering will be incorrect when,
      // for example, switching between "All JavaScript" and a specific bundle.
      delete node.dom;

      // @ts-ignore: webtreemap used `size` to partition the treemap.
      node.size = node[mode.partitionBy || 'resourceBytes'];
    });
    webtreemap.sort(this.currentRootNode);

    this.el.innerHTML = '';
    this.render();
  }

  render() {
    webtreemap.render(this.el, this.currentRootNode, {
      padding: [18, 3, 3, 3],
      caption: node => this.makeCaption(node),
    });
    this.updateColors();
  }

  /**
   * @param {Treemap.Node} node
   */
  makeCaption(node) {
    const total = this.currentRootNode[this.mode.partitionBy || 'resourceBytes'];
    const sections = [
      {
        calculate: node => Util.elide(node.name, 60),
      },
      {
        label: this.mode.partitionBy,
        calculate: node => {
          const unit = this.mode.partitionBy === 'executionTime' ? 'time' : 'bytes';
          const value = node[this.mode.partitionBy || 'resourceBytes'];
          return `${Util.format(value, unit)} (${Math.round(value / total * 100)}%)`;
        },
      },
    ];

    return sections.map(section => {
      // Only print the label for the root node.
      if (node === this.currentRootNode && section.label) {
        return `${section.label}: ${section.calculate(node)}`;
      } else {
        return section.calculate(node);
      }
    }).join(' • ');
    // legacy ---

    dfs(node, node => {
      // const {bytes, wastedBytes, executionTime} = node;
      // TODO: this is from pauls code
      // node.id += ` • ${Number.bytesToString(bytes)} • ${Common.UIString('%.1f\xa0%%', bytes / total * 100)}`;

      node.name = sections.map(section => {
        // Only print the label for the root node.
        if (node === this.currentRootNode && section.label) {
          return `${section.label}: ${section.calculate(node)}`;
        } else {
          return section.calculate(node);
        }
      }).join(' • ');

      // const title = Util.elide(node.originalId, 60);
      // const value = node[this.mode.partitionBy];
      // const unit = this.mode.partitionBy === 'executionTime' ? 'time' : 'bytes';
      // // node.id = `${Util.elide(node.originalId, 60)} • ${Util.formatBytes(bytes)} • ${Math.round(bytes / total * 100)}%`;
      // node.id = `${title} • ${Util.format(value, unit)} ${this.mode.partitionBy} (${Math.round(value / total * 100)}%)`;


      // if (this.mode.partitionBy === 'bytes') {
      //   const total = this.currentRootNode.bytes;
      //   node.id = `${Util.elide(node.originalId, 60)} • ${Util.formatBytes(bytes)} • ${Math.round(bytes / total * 100)}%`;
      // } else if (this.mode.partitionBy === 'wastedBytes') {
      //   // node.id = `${Util.elide(node.originalId, 60)} • ${Util.formatBytes(wastedBytes)} wasted • ${Math.round((1 - wastedBytes / bytes) * 100)}% usage`;
      //   node.id = `${Util.elide(node.originalId, 60)} • ${Util.formatBytes(wastedBytes)} wasted • ${Math.round(wastedBytes / this.currentRootNode.wastedBytes * 100)}%`;
      // } else if (this.mode.partitionBy === 'executionTime' && executionTime !== undefined) {
      //   node.id = `${Util.elide(node.originalId, 60)} • ${Math.round(executionTime)} ms • ${Math.round(executionTime / this.currentRootNode.executionTime * 100)}%`;
      // } else {
      //   node.id = Util.elide(node.originalId, 60);
      // }
    });
  }

  updateColors() {
    dfs(this.currentRootNode, node => {
      if (!node.dom) return;

      // A view can set nodes to highlight. Don't color anything else.
      if (this.mode.highlightNodeIds) {
        if (this.mode.highlightNodeIds.includes(node.name)) {
          // TODO: 'names' are just filenames, which aren't unique.
          node.dom.style.backgroundColor = 'yellow';
        }
        return;
      }

      // Color a root node and all children the same color.
      const rootNode = this.nodeToRootNodeMap.get(node);
      const hueKey = rootNode ? rootNode.name : node.name;
      const hue = this.getHue(hueKey);

      // Ran out of colors.
      if (hue === undefined) return;

      const sat = 60;
      const lum = 90;

      node.dom.style.backgroundColor = Util.hsl(hue, sat, Math.round(lum));
      node.dom.style.color = lum > 50 ? 'black' : 'white';
    });
  }

  createHeader() {
    const bundleSelectorEl = /** @type {HTMLSelectElement} */ (Util.find('.bundle-selector'));
    const partitionBySelectorEl = /** @type {HTMLSelectElement} */ (
      Util.find('.partition-selector'));
    const toggleTableBtn = Util.find('.lh-button--toggle-table');

    bundleSelectorEl.innerHTML = '';

    function makeOption(value, text) {
      const optionEl = document.createElement('option');
      optionEl.value = value;
      optionEl.innerText = text;
      bundleSelectorEl.append(optionEl);
    }

    function onChange() {
      let selectorValue = bundleSelectorEl.value;
      let selectorType = /** @type {Treemap.DataSelector['type']} */ ('rootNodeId');
      if (selectorValue.startsWith('group:')) {
        selectorValue = selectorValue.replace('group:', '');
        selectorType = 'group';
      }

      treemapViewer.show({
        ...treemapViewer.mode,
        selector: {
          type: selectorType,
          value: selectorValue,
          viewId: treemapViewer.mode.selector.viewId,
        },
        partitionBy: partitionBySelectorEl.value,
      });
    }

    for (const [group, rootNodes] of Object.entries(this.treemapData)) {
      const aggregateNodes = rootNodes.length > 1 && group !== 'misc';

      if (aggregateNodes) {
        makeOption('group:' + group, `All ${group}`);
      }

      for (const rootNode of rootNodes) {
        if (!rootNode.node.children) continue; // Only add bundles.
        const title = (aggregateNodes ? '- ' : '') + Util.elide(rootNode.name, 80);
        makeOption(rootNode.name, title);
      }
    }

    if (this.mode.selector.type === 'group') {
      bundleSelectorEl.value = 'group:' + this.mode.selector.value;
    } else {
      bundleSelectorEl.value = this.mode.selector.value;
    }
    bundleSelectorEl.addEventListener('change', onChange);
    partitionBySelectorEl.addEventListener('change', onChange);
    toggleTableBtn.addEventListener('click', () => treemapViewer.toggleTable());
  }

  /**
   * @param {Treemap.RootNode[]} rootNodes
   */
  createTable(rootNodes) {
    const gridPanelEl = Util.find('.panel--datagrid');
    gridPanelEl.innerHTML = '';

    /** @type {Array<{name: string, bytes: {resource: number, unused?: number}}>} */
    const data = [];
    let maxSize = 0;
    for (const rootNode of rootNodes) {
      const node = rootNode.node;
      // if (node.children) node = node.children[0];

      dfs(node, (node, fullId) => {
        if (node.children) return;

        if (node.resourceBytes) maxSize = Math.max(maxSize, node.resourceBytes);
        data.push({
          name: fullId,
          bytes: {resource: node.resourceBytes, unused: node.unusedBytes},
        });
      });
    }

    const gridEl = document.createElement('div');
    gridPanelEl.append(gridEl);

    /**
     * @param {typeof data[0]['bytes']} a
     * @param {typeof data[0]['bytes']} b
     * @return {number}
     */
    const bytesSorter = (a, b) => a.resource - b.resource;

    this.table = new Tabulator(gridEl, {
      data,
      height: '100%',
      layout: 'fitColumns',
      tooltips: true,
      addRowPos: 'top',
      history: true,
      resizableRows: true,
      initialSort: [
        {column: 'bytes', dir: 'desc'},
      ],
      columns: [
        {title: 'Name', field: 'name'},
        {title: 'Size / Unused', field: 'bytes', sorter: bytesSorter, formatter: cell => {
          const value = cell.getValue();
          return `${Util.formatBytes(value.resource)} / ${Util.formatBytes(value.unused)}`;
        }},
        {title: 'Size / Unused', field: 'bytes', sorter: bytesSorter, formatter: cell => {
          const value = cell.getValue();

          const el = Util.createElement('div', 'lh-coverage-bar');
          el.style.setProperty('--max', String(maxSize));
          el.style.setProperty('--used', String(value.resource - value.unused));
          el.style.setProperty('--unused', String(value.unused));

          Util.createChildOf(el, 'div', 'lh-coverage-bar--used');
          Util.createChildOf(el, 'div', 'lh-coverage-bar--unused');

          return el;
        }},
      ],
    });
  }

  toggleTable() {
    const mainEl = Util.find('main');
    mainEl.addEventListener('animationstart', () => {
      console.log('Animation started');
    });
    mainEl.classList.toggle('lh-main__show-table');
    this.render();
  }
}

/**
 * @param {Treemap.RootNode[]} rootNodes
 * @param {Treemap.Mode} currentMode
 */
function createViewModes(rootNodes, currentMode) {
  const viewModesPanel = Util.find('.panel--modals');

  /**
   * @param {Treemap.DataSelector['viewId']} viewId
   * @param {string} name
   * @param {Partial<Treemap.Mode>} modeOptions
   */
  function makeViewMode(viewId, name, modeOptions) {
    const isCurrentView = viewId === currentMode.selector.viewId;
    const viewModeEl = document.createElement('div');
    viewModeEl.classList.add('view-mode');
    if (isCurrentView) viewModeEl.classList.add('view-mode--active');
    viewModeEl.innerText = name;
    viewModeEl.addEventListener('click', () => {
      /** @type {Treemap.Mode} */
      const newMode = {
        ...currentMode,
        highlightNodeIds: undefined,
        ...modeOptions,
        selector: {
          ...currentMode.selector,
          viewId,
        },
      };

      if (isCurrentView) {
        // Do nothing.
        return;
      }

      treemapViewer.show(newMode);
    });

    viewModesPanel.append(viewModeEl);
  }

  // TODO: Sort by savings?

  viewModesPanel.innerHTML = '';

  {
    let bytes = 0;
    for (const rootNode of rootNodes) {
      dfs(rootNode.node, node => {
        if (node.children) return; // Only consider leaf nodes.

        bytes += node.resourceBytes;
      });
    }
    makeViewMode('all', `All (${Util.formatBytes(bytes)})`, {
      partitionBy: 'resourceBytes',
    });
  }

  {
    let bytes = 0;
    /** @type {string[]} */
    const highlightNodeIds = [];
    for (const rootNode of rootNodes) {
      dfs(rootNode.node, node => {
        if (node.children) return; // Only consider leaf nodes.
        if (!node.unusedBytes || node.unusedBytes < 50 * 1024) return;

        bytes += node.unusedBytes;
        highlightNodeIds.push(node.name);
      });
    }
    if (bytes) {
      makeViewMode('unused-js', `Unused JS (${Util.formatBytes(bytes)})`, {
        partitionBy: 'unusedBytes',
        highlightNodeIds,
      });
    }
  }

  {
    let bytes = 0;
    /** @type {string[]} */
    const highlightNodeIds = [];
    for (const rootNode of rootNodes) {
      if (!rootNode.node.children) continue; // Only consider bundles.

      dfs(rootNode.node, node => {
        if (node.children) return; // Only consider leaf nodes.
        if (node.resourceBytes < 200 * 1024) return;

        bytes += node.resourceBytes;
        highlightNodeIds.push(node.name);
      });
    }
    if (bytes) {
      makeViewMode('large-js', `Large Modules (${Util.formatBytes(bytes)})`, {
        partitionBy: 'resourceBytes',
        highlightNodeIds,
      });
    }
  }

  {
    let bytes = 0;
    /** @type {string[]} */
    const highlightNodeIds = [];
    const duplicateIdsSeen = new Set();
    for (const rootNode of rootNodes) {
      if (!rootNode.node.children) continue; // Only consider bundles.

      dfs(rootNode.node, node => {
        if (node.children) return; // Only consider leaf nodes.
        if (!node.duplicate) return;
        if (duplicateIdsSeen.has(node.duplicate)) return;
        duplicateIdsSeen.add(node.duplicate);

        bytes += node.resourceBytes;
        highlightNodeIds.push(node.name);
      });
    }
    if (bytes) {
      makeViewMode('duplicate-js', `Duplicate Modules (${Util.formatBytes(bytes)})`, {
        partitionBy: 'resourceBytes',
        highlightNodeIds,
      });
    }
  }
}

/**
 * @param {Treemap.Options} options
 */
function init(options) {
  treemapViewer = new TreemapViewer(options, Util.find('.panel--treemap'));
  treemapViewer.createHeader();
  treemapViewer.show(options.mode); // ?
  treemapViewer.initListeners();

  // For debugging.
  window.__treemapViewer = treemapViewer;

  if (self.opener && !self.opener.closed) {
    self.opener.postMessage({rendered: true}, '*');
  }

  if (window.ga) {
    // TODO what are these?
    // window.ga('send', 'event', 'treemap', 'open in viewer');
    window.ga('send', 'event', 'report', 'open in viewer');
  }

  console.log({options});
}

async function main() {
  if (new URLSearchParams(window.location.search).has('debug')) {
    const response = await fetch('debug.json');
    const json = await response.json();
    window.__TREEMAP_OPTIONS = json;
  }

  if (window.__TREEMAP_OPTIONS) {
    init(window.__TREEMAP_OPTIONS);
  } else {
    window.addEventListener('message', e => {
      if (e.source !== self.opener) return;

      /** @type {Treemap.Options} */
      const options = e.data;
      const {lhr, mode} = options;
      const documentUrl = lhr.requestedUrl;
      if (!documentUrl || !mode) return;

      // Allows for saving the document and loading with data intact.
      const scriptEl = document.createElement('script');
      scriptEl.innerText = `window.__TREEMAP_OPTIONS = ${JSON.stringify(options)};`;
      document.head.append(scriptEl);

      init(options);
    });
  }

  // If the page was opened as a popup, tell the opening window we're ready.
  if (self.opener && !self.opener.closed) {
    self.opener.postMessage({opened: true}, '*');
  }
}

document.addEventListener('DOMContentLoaded', main);
