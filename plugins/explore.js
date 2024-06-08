// @author         Mike Castle
// @name           Explore
// @category       Misc
// @version        0.0.0
// @description    Explore a bounded area.

var changelog = [
  {
    version: '0.0.0',
    changes: ['Initial version.'],
  },
];

// use own namespace for plugin
window.plugin.explore = function() {};

// Where we put things in localStorage.
window.plugin.explore.KEY_STORAGE = 'plugin-explore';

// Delay, in ms, between detecting all portals are loaded and then processing
// them.
window.plugin.explore.DELAY_RANGE = [1000, 10000];

// Distance, in meters, that the center must be to be considered inside the
// boundary.  Rounding errors can make it seem the start point is outside the
// bounds.
window.plugin.explore.CLOSE_ENOUGH = 200;

/** @type {window.plugin.explore.State} */
window.plugin.explore.state = null;

/**
 * @typedef {object} Portal
 * @property {string} guid
 * @property {string} label
 * @property {string} latlng
 */

window.plugin.explore.Exception = class extends Error {};

/** Wrapper for data saved to localStorage. */
window.plugin.explore.Data = class {

  constructor(state) {
    this.#state = state;
  }

  /** @type {L.LatLngBounds} - User defined boundary. */
  get boundary() {
    return this.#boundary;
  }

  /** @param {L.LatLngBounds} val - User defined boundary. */
  set boundary(val) {
    this.#boundary = val;
    this.#current = null;
    this.save();
    this.#state.updateBounds();
  }

  /** @type {L.LatLng} - Current center point just explored. */
  get current() {
    return this.#current;
  }

  /** @param {L.LatLng} val - Current center point just explored. */
  set current(val) {
    this.#current = val;
    this.save();
  }

  /** @type {Map<string,Portal} */
  get portals() {
    return this.#portals;
  }

  /**
   * @param {L.circleMarker} marker - As enhanced when added to
   * window.portals.
   */
  addPortal(marker) {
    const guid = marker.options.guid;
    const label = marker.options.data.title;
    const ll = marker.getLatLng();
    const latlng = `${ll.lat},${ll.lng}`;
    const portal = {
      guid: guid,
      label: label,
      latlng: latlng,
    };
    this.portals.set(guid, portal);
  }

  /** Clear the portal data. */
  clearPortals() {
    this.#portals.clear();
    this.save();
  }

  /**
   * Light wrapper around {L.LatLngBounds.extend}.
   * @param {L.LatLngBounds} bounds
   */
  extendBoundary(bounds) {
    this.boundary.extend(bounds);
    this.boundary = this.boundary;
  }

  /** Load data from localStorage. */
  load() {
    this.#loading = true;
    const rawData = localStorage.getItem(window.plugin.explore.KEY_STORAGE)
          || '{}';
    this.#fromPojo(JSON.parse(rawData));
    this.#loading = false;
    if (this.#deferSaved) {
      this.save();
    }
  }

  /** Save data to localStorage. */
  save() {
    if (this.#loading) {
      this.#deferSaved = true;
    } else {
      const pojo = this.#toPojo();
      try {
        localStorage.setItem(window.plugin.explore.KEY_STORAGE,
                             JSON.stringify(pojo));
      } catch (exc) {
        if (exc instanceof DOMException && exc.name === 'QuotaExceededError') {
          throw new window.plugin.explore.Exception('Storage quota exceeded');
        }
        throw exc;
      }
    }
  }

  #boundary
  #current
  #deferSaved = false;
  #loading
  #portals = new Map();
  #state

  /** Modify current data to a plain-old JavaScript object. */
  #toPojo() {
    const ne = this.boundary.getNorthEast();
    const sw = this.boundary.getSouthWest();
    const pojo = {
      boundary: {
        ne: {lat: ne.lat, lng: ne.lng},
        sw: {lat: sw.lat, lng: sw.lng},
      },
      portals: {},
    };
    if (this.current) {
      pojo.current = {lat: this.current.lat, lng: this.current.lng};
    }
    for (const [guid, portal] of this.portals.entries()) {
      pojo.portals[guid] = portal;
    }
    return pojo;
  }

  /** Populate current data from a plain-old JavaScript object. */
  #fromPojo(pojo) {
    if (Object.hasOwn(pojo, 'boundary')) {
      this.boundary = L.latLngBounds(pojo.boundary.ne, pojo.boundary.sw)
    } else {
      this.boundary = window.map.getBounds();
    }
    if (Object.hasOwn(pojo, 'current')) {
      this.current = L.latLng(pojo.current);
    }
    if (Object.hasOwn(pojo, 'portals')) {
      for (const [guid, portal] of Object.entries(pojo.portals)) {
        this.portals.set(guid, portal);
      }
    }
  }

}

/** Manages most state for exploring. */
window.plugin.explore.State = class {

  constructor() {
    this.#layerGroup = L.layerGroup();
    this.#data = new window.plugin.explore.Data(this);
    this.#data.load();
  }

  /** @type (number} - The number of portals seen in last map view. */
  get counted() {
    return this.#counted;
  }

  /** @type {window.plugin.explore.Data} - Processed data. */
  get data() {
    return this.#data;
  }

  /** @type {jQuery.Widget} - Current dialog (doubles as a dashboard). */
  get dialog() {
    return this.#dialog;
  }

  /** @param {jQuery.Widget} val - Current dialog (doubles as a dashboard). */
  set dialog(val) {
    this.#dialog = val;
    if (val) {
      this.#populateDialog();
    }
  }

  /** @type {string[]} - Defines names for the dashboard fields. */
  get dialogKeys() {
    return Object.keys(this.#dialogMapping);
  }

  /** @type {boolean} - Current status of exploring. */
  get exploring() {
    return this.#exploring;
  }

  /** @type {number} - Number of map views processed. */
  get iteration() {
    return this.#iteration;
  }

  /** @type {L.LayerGroup} - Used by IITC's Layer Chooser. */
  get layerGroup() {
    return this.#layerGroup;
  }

  /** @type {string} - Time of last process action. */
  get processTime() {
    return this.#formatDate(this.#processTime);
  }

  /** @type {string} - Start time of current/last exploration. */
  get startTime() {
    return this.#formatDate(this.#startTime);
  }

  /** @type {string} - Stop time of last exploration. */
  get stopTime() {
    return this.#formatDate(this.#stopTime);
  }

  /** @type {string} - Generic status message for the dashboard. */
  get status() {
    return this.#status || 'No status';
  }

  /** @param {string} val - Generic status message for the dashboard. */
  set status(val) {
    this.#status = val;
    this.#populateDialog();
  }

  /** @type {number} - Current number of portals known about. */
  get total() {
    return this.data.portals.size;
  }

  /** Clear out the portal data. */
  clear() {
    this.stop();
    this.data.clearPortals();
    this.#populateDialog();
  }

  /** Process the current view of the map. */
  process() {
    if (this.exploring) {
      try {
        const bounds = window.map.getBounds();
        const inter = this.data.boundary.intersects(bounds);
        if (window.map.getZoom() === window.DEFAULT_ZOOM && inter) {
          this.#iteration += 1;

          this.#counted = 0;
          for (const [guid, marker] of Object.entries(window.portals)) {
            if (bounds.contains(marker.getLatLng())) {
              this.#counted += 1;
              if (marker.options.data.title) {
                this.data.addPortal(marker);
              } else {
                console.log('placeholder:', marker.options.data);
                this.stop('Saw placeholder (bug?)');
                return;
              }
            }
          }
          this.#processTime = new Date();
          this.#populateDialog();
          this.data.current = bounds.getCenter();
          this.#addCountLabel(this.data.current, this.#counted);
          L.rectangle(bounds, {color: this.#colorExplored})
            .addTo(this.layerGroup);
          this.#nextDest();
          window.idleReset();
        } else {
          this.status = 'Saw bad zoom or location, reset';
          this.#moveTo(this.#startDest());
        }
      } catch (exc) {
        if (exc instanceof window.plugin.explore.Exception) {
          this.stop(`${exc.name}: ${exc.message}`);
        } else {
          throw exc;
        }
      }
    }
    this.delay = null;
  }

  /** Save portals to a file. */
  save() {
    const portals = {};
    for (const [guid, portal] of this.data.portals.entries()) {
      portals[guid] = portal;
    }
    const data = {
      portals: {
        idExplore: {
          bkmrk: portals,
          label: 'Explored',
        }
      }
    }
    const dateSeq = this.#sequenceDate(new Date());
    const filename = `IITC-exploration-${dateSeq}.json`;
    window.saveFile(JSON.stringify(data, null, 2),
                    filename,
                    'application/json');
    this.status = `Saved to ${filename}`;
  }

  /** Start exploring the current bounds. */
  start() {
    if (!this.#exploring) {
      this.status = 'Started';
      this.#exploring = true;
      const zoom = window.map.getZoom();
      if (window.mapDataRequest.status.short === 'done'
          && window.mapDataRequest.fetchedDataParams.mapZoom === zoom) {
        // Trick into reloading data in case we did not move far.
        window.mapDataRequest.fetchedDataParams.mapZoom = 0;
      }
      this.#startTime = new Date();
      this.#stopTime = null;
      this.#moveTo(this.#startDest());
      this.#populateDialog();
    }
  }

  /**
   * Stop the current exploration.
   * @param {string} [msg] - Special message to set for status AND
   * notification.
   */
  stop(msg=null) {
    if (this.exploring) {
      if (msg) {
        const opts = {
          body: msg,
          requireInteraction: true,
        }
        const note = new Notification('Exploring stopped', opts);
        this.status = msg;
      } else {
        this.status = 'Stopped';
      }
      this.#stopTime = new Date();
      this.#processTime = null;
    }
    this.#exploring = false;
    this.#populateDialog();
  }

  /** Triggers updating the boundary on the map layer. */
  updateBounds() {
    this.stop();
    if (this.#rect) {
      this.#rect.removeFrom(this.layerGroup);
    }
    this.refreshLayers();
  }

  /** Gives the map layer a good cleaning, leaving only the boundary. */
  refreshLayers() {
    this.layerGroup.clearLayers();
    this.#rect = L.rectangle(this.data.boundary, {color: this.#colorBoundary});
    this.#rect.addTo(this.layerGroup);
  }

  #colorBoundary = 'red';
  #colorExplored = 'orange';
  #counted = 0;
  #data
  #dialog
  #dialogMapping = {
    'Exploring': 'exploring',
    'Views explored': 'iteration',
    'Last process count': 'counted',
    'Last process time': 'processTime',
    'Total portal count': 'total',
    'Start time': 'startTime',
    'Stop time': 'stopTime',
    'Status': 'status',
  };
  #exploring = false;
  #iteration = 0;
  #layerGroup
  #processTime = null;
  #rect
  #startTime = null;
  #stopTime = null;
  #status = null;
  #visible = false;

  /**
   * Add a summary label (marker) to the map layer.
   * @param {L.LatLng} latlng - Where to place the label.
   * @param {number} count - Portals just counted.
   */
  #addCountLabel(latlng, count) {
    const marker = L.marker(latlng, {
      icon: L.divIcon({
        className: 'leaflet-div-icon plugin-explore-labels',
        iconSize: [40, 30],
        html: `Portals: ${count}`,
      }),
    });
    marker.addTo(this.layerGroup);
  }

  /**
   * Small wrapper around IITC's unixTimeToDateTimeString.
   * @param {Date|null} date - Date to format.
   * @returns {string} - Formated date or a placeholder
   */
  #formatDate(date) {
    let result = '--';
    if (date) {
      result = window.unixTimeToDateTimeString(date.getTime(), false)
    }
    return result;
  }

  /** Try to pan east, otherwise move southwest. */
  #goEast() {
    const test = new L.LatLng(window.map.getCenter().lat,
                              this.data.boundary.getEast());
    if (window.map.getBounds().contains(test)) {
      this.status = 'Saw the eastern border';
      this.#goSouthWest();
    } else {
      const mapSize = window.map.getSize();
      const offset = new L.Point(mapSize.x * 95 / 100, 0);
      window.map.panBy(offset, {animate: false});
      this.status = 'Moved due east';
    }
  }

  /** Move southwest, like an old typewriter doing a carriage return. */
  #goSouthWest() {
    const test = new L.LatLng(this.data.boundary.getSouth(),
                              window.map.getCenter().lng);
    if (window.map.getBounds().contains(test)) {
      this.stop('Saw the southern border');
      this.data.current = null;
      // this.status = 'Saw the southern border';
    } else {
      const dest = new L.LatLng(window.map.getBounds().getSouth(),
                                this.data.boundary.getWest());
      this.#moveTo(dest);
      // If there is room, do a pan as well.
      if (test.lat < window.map.getBounds().getSouth()) {
        const mapSize = window.map.getSize();
        const offset = new L.Point(0, mapSize.y * 45 / 100);
        window.map.panBy(offset, {animate: false});
      }
      this.status = 'Moved southwest';
    }
  }

  /**
   * Map rounding will sometimes get it wrong so... try close enough to the
   * boundary.
   * @param {L.LatLng} latlng - Location to test.
   * @return {boolean} - If latlng is inside the boundary.
   */
  #isClose(latlng) {
    const test = latlng.toBounds(window.plugin.explore.CLOSE_ENOUGH);
    const result = this.data.boundary.intersects(test);
    return result;
  }

  /**
   * Small wrapper around map.setView().
   * @param {L.LatLng} latlng - Location to center.
   */
  #moveTo(latlng) {
    window.map.setView(latlng, window.DEFAULT_ZOOM, {animate: false});
  }

  /** Determine where to explore next. */
  #nextDest() {
    if (this.#isClose(window.map.getCenter())) {
      this.#goEast();
    } else {
      this.#goSouthWest();
    }
  }

  /** Update the dialog/dashboard. */
  #populateDialog() {
    if (this.dialog) {
      for (const [key, prop] of Object.entries(this.#dialogMapping)) {
        const cell = this.dialog.find(`[data-id='${key}']`);
        cell.text(this[prop]);
      }
    }
  }

  /**
   * Turn a timestamp into YYYY-MM-DD-seconds.
   * @param {Date} date - Date to format.
   * @returns {string} - Formated date.
   */
  #sequenceDate(date) {
    const yyyy = date.getFullYear();
    const mm = window.zeroPad(date.getMonth() + 1, 2);
    const dd = window.zeroPad(date.getDate(), 2);
    const seq = window.zeroPad(date.getHours() * 3600
                               + date.getMinutes() * 60
                               + date.getSeconds(), 5);
    const dateStr = `${yyyy}-${mm}-${dd}-${seq}`;
    return dateStr;
  }

  /**
   * Determine an appropriate starting point.  Maybe one saved from an
   * interrupted exploration, otherwise, the northwest corner of the boundary.
   * @return {L.LatLng} - A good starting location.
   */
  #startDest() {
    let dest = this.data.current || this.data.boundary.getNorthWest();
    if (!this.#isClose(dest)) {
      dest = this.data.boundary.getNorthWest();
    }
    return dest;
  }

}

/** Triggered after a suitable delay. */
window.plugin.explore.processMap = function() {
  window.plugin.explore.state.process();
}

/** Triggered after all portals in the current view are loaded. */
window.plugin.explore.dataRefreshed = function() {
  const state = window.plugin.explore.state;
  if (state.exploring) {
    if (state.delay) {
      status.status = 'Map moved during process; stop that!';
      return;
    }
    const [low, high] = window.plugin.explore.DELAY_RANGE;
    state.delay = Math.floor(low + Math.random() * (high - low));
    state.status = `Waiting for ${state.delay} ms`;
    setTimeout(window.plugin.explore.processMap, state.delay);
  }
}

/** Triggered from a command button. */
window.plugin.explore.tbd = function() {
  window.plugin.explore.state.status = 'Command not implemented';
}

/** Triggered from a command button. */
window.plugin.explore.toggle = function() {
  const state = window.plugin.explore.state;

  if (state.exploring) {
    state.stop();
  } else {
    state.start();
  }
}

/** Triggered from a command button. */
window.plugin.explore.save = function() {
  window.plugin.explore.state.save();
}

/** Triggered from a command button. */
window.plugin.explore.clear = function() {
  window.plugin.explore.state.clear();
}

/** Triggered from a command button. */
window.plugin.explore.refresh = function() {
  window.plugin.explore.state.refreshLayers();
}

/** Triggered from a command button. */
window.plugin.explore.use_view = function() {
  const state = window.plugin.explore.state;
  state.data.boundary = window.map.getBounds();
  state.status = 'Bounds set to current view';
}

/** Triggered from a command button. */
window.plugin.explore.extend_view = function() {
  const state = window.plugin.explore.state;
  state.data.extendBoundary(window.map.getBounds());
  state.status = 'Bounds now includes current view';
}

/** Triggered from a command button. */
window.plugin.explore.use_drawtools = function() {
  const state = window.plugin.explore.state;
  const bounds = window.plugin.drawTools.drawnItems.getBounds();
  if (bounds.isValid()) {
    state.data.boundary = bounds;
    state.status = 'Bounds set from DrawTools';
  } else {
    state.status = 'Setting from DrawTools failed (no drawing?)';
  }
}

/** Triggered from a command button. */
window.plugin.explore.use_bookmarks = function() {
  const state = window.plugin.explore.state;
  const group = L.featureGroup(
    window.plugin.bookmarks.starLayerGroup.getLayers());
  const bounds = group.getBounds();
  if (bounds.isValid()) {
    state.data.boundary = bounds;
    state.status = 'Bounds set from Bookmarks';
  } else {
    state.status = 'Setting from Bookmarks failed (none saved?)';
  }
}

/** Opens the dialog/dashboard. */
window.plugin.explore.central = function() {
  const explore = window.plugin.explore;
  const commands = [
    {label: 'Toggle Exploring', func: explore.toggle},
    {label: 'Save Exploration', func: explore.save},
    {label: 'Clear Exploration', func: explore.clear},
    {label: 'Refresh Explored View', func: explore.refresh},
    {label: 'Set Boundary from View', func: explore.use_view},
    {label: 'Extend Boundary to View', func: explore.extend_view},
  ];
  if (window.plugin.drawTools) {
    commands.push({
      label: 'Set boundary from DrawTools',
      func: explore.use_drawtools,
    });
  }
  if (window.plugin.bookmarks) {
    commands.push({
      label: 'Set boundary from Bookmarks',
      func: explore.use_bookmarks,
    });
  }
  if (window.Notification && Notification.permission === 'default') {
    commands.push({
      label: 'Allow stop notifications',
      func: Notification.requestPermission,
    });
  }
  const html = `<div class='button-menu'>
    </div>`;
  const dia = dialog({
    title: 'Explore Central',
    id: 'explore-central',
    html: html,
  });
  const div = dia.find('div');
  const commandMap = new Map();
  for (const item of commands) {
    const button = document.createElement('button');
    button.innerText = item.label;
    commandMap.set(item.label, item.func);
    div.append(button);
  }
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (const item of window.plugin.explore.state.dialogKeys) {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    const value = document.createElement('td');
    label.innerText = `${item}:`;
    value.innerText = 'Unknown';
    value.dataset.id = item;
    row.append(label, value);
    tbody.append(row);
  }
  table.append(tbody);
  div.append(table);
  dia.on('dialogclose', () => {window.plugin.explore.state.dialog = null;});
  window.plugin.explore.state.dialog = dia;
  dia.find('button')
    .on('click', (evt) => commandMap.get(evt.target.innerText)());
}

/** Called when IITC is fully loaded. */
window.plugin.explore.iitcLoaded = function() {
  window.plugin.explore.state = new window.plugin.explore.State();
  window.addHook('mapDataRefreshEnd', window.plugin.explore.dataRefreshed);
  window.layerChooser.addOverlay(
    window.plugin.explore.state.layerGroup,
    'Explore bounds',
    {default: false},
  );
}

/** IITC plugin entry point. */
function setup() {
  const style = `<style>
    .button-menu button {
      display: block;
      width: 80%;
      margin: 10px auto;
      &:hover {
        text-decoration: underline;
      }
    }
    .plugin-explore-labels {
      line-height: normal;
    }
  </style>`;
  $('head').append(style);

  window.addHook('iitcLoaded', window.plugin.explore.iitcLoaded);

  window.IITC.toolbox.addButton({
    label: 'Explore',
    title: 'Explore a bounded area',
    action: window.plugin.explore.central,
  });
}
