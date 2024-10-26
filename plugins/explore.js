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

  /** @type {boolean} - Whether to use automation. */
  get useAutomation() {
    return this.#useAutomation;
  }

  /** @param {boolean} val - Whether to use automation. */
  set useAutomation(val) {
    this.#useAutomation = val;
    this.save();
  }

  /** @type {boolean} - Whether to use notifications. */
  get useNotifications() {
    return this.#useNotifications;
  }

  /** @param {boolean} val - Whether to use notifications. */
  set useNotifications(val) {
    this.#useNotifications = val;
    this.save();
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
          throw new window.plugin.explore.Exception(
            'Storage quota exceeded', {cause: exc});
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
  #useAutomation = false;
  #useNotifications = false;

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
      useAutomation: this.#useAutomation,
      useNotifications: this.#useNotifications,
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
    if (Object.hasOwn(pojo, 'useNotifications')) {
      this.useNotifications = pojo.useNotifications;
    }
    if (Object.hasOwn(pojo, 'useAutomation')) {
      this.useAutomation = pojo.useAutomation;
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

  /** @type {string} - Progress of the exploration. */
  get progress() {
    const {ntos, wtoe} = this.#progress();
    return `NtoS: ${ntos} WtoE: ${wtoe}`;
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

  /**
   * @param {L.circleMarker} marker - As enhanced when added to
   * window.portals.
   */
  cacheMarker(marker) {
    this.#markerCache.set(marker.options.guid, marker);
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
          for (let [guid, marker] of Object.entries(window.portals)) {
            if (bounds.contains(marker.getLatLng())) {
              this.#counted += 1;
              if (!marker.options.data.title) {
                console.log(`Checking the cache for ${guid}.`);
                marker = this.#markerCache.get(guid) || marker;
              }
              if (marker.options.data.title) {
                this.data.addPortal(marker);
              } else {
                // getEntities often drops moved portals.  Affects stock intel
                // as well, only it does not even bother with a placeholder.
                window.renderPortalDetails(marker.options.guid);
                console.log('placeholder:', marker.options.data);
                this.stop('Saw placeholder (link to a moved portal?)');
                return;
              }
            }
          }
          this.#processTime = new Date();
          this.data.current = bounds.getCenter();
          this.#populateDialog();
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
          if (this.data.useAutomation) {
            this.save();
            this.clear();
            this.start();
          }
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
        if (this.data.useNotifications) {
          new Notification('Exploring stopped', opts);
        }
        this.status = msg;
      } else {
        this.status = 'Stopped';
      }
      this.#stopTime = new Date();
      this.#processTime = null;
    }
    this.delay = null;
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
    'Progress': 'progress',
    'Status': 'status',
  };
  #exploring = false;
  #iteration = 0;
  #layerGroup
  #markerCache = new Map();
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
    const test = L.latLng(window.map.getCenter().lat,
                          this.data.boundary.getEast());
    if (window.map.getBounds().contains(test)) {
      this.status = 'Saw the eastern border';
      this.#goSouthWest();
    } else {
      const mapSize = window.map.getSize();
      const offset = L.point(mapSize.x * 95 / 100, 0);
      window.map.panBy(offset, {animate: false});
      this.status = 'Moved due east';
    }
  }

  /** Move southwest, like an old typewriter doing a carriage return. */
  #goSouthWest() {
    const test = L.latLng(this.data.boundary.getSouth(),
                          window.map.getCenter().lng);
    if (window.map.getBounds().contains(test)) {
      this.data.current = null;
      this.stop('Saw the southern border');
      if (this.data.useAutomation) {
        this.save();
        this.clear();
      }
    } else {
      const dest = L.latLng(window.map.getBounds().getSouth(),
                            this.data.boundary.getWest());
      this.#moveTo(dest);
      // If there is room, do a pan as well.
      if (test.lat < window.map.getBounds().getSouth()) {
        const mapSize = window.map.getSize();
        const offset = L.point(0, mapSize.y * 45 / 100);
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
   * Compute how far current is from the start point.
   * @return [{string}, {string}] - Percent progressed.
   */
  #progress() {
    let ntos = '--';
    let wtoe = '--';
    if (this.data.current) {
      const {lat, lng} = this.data.current;
      const bounds = this.data.boundary;
      const north = L.latLng({lat: bounds.getNorth(), lng: lng});
      const south = L.latLng({lat: bounds.getSouth(), lng: lng});
      const west = L.latLng({lat: lat, lng: bounds.getWest()});
      const east = L.latLng({lat: lat, lng: bounds.getEast()});
      ntos = Math.round(100 * north.distanceTo(this.data.current)
                        / north.distanceTo(south));
      ntos = `${ntos}%`;
      wtoe = Math.round(100 * west.distanceTo(this.data.current)
                        / west.distanceTo(east));
      wtoe = `${wtoe}%`;
    }
    return {ntos: ntos, wtoe: wtoe};
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

/**
 * Prepend an `input` to an element.
 * @param {HTMLElement} element - Element to modify.
 * @param {object} config - Initial configuration.
 * @param {function(Event)} changeHandler - Handler for `change` event.
 */
window.plugin.explore._prependInput = function(element, config, changeHandler) {
  const input =  document.createElement('input');
  Object.assign(input, config);
  input.addEventListener('change', changeHandler);
  element.prepend(input);
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

/**
 * Triggered after a portal is viewed.
 *
 * When we come across a problem portal, we use {@link renderPortalDetails} to
 * force a refresh of its data.  This function captures that refresh and
 * caches it.
 *
 * Also, if exploring was stopped because of this, optionally restart.
 * @param {Object} details - Portal details.
 **/
window.plugin.explore.portalDetailsUpdated = function(details) {
  const state = window.plugin.explore.state;

  state.cacheMarker(details.portal);
  if (!state.exploring
      && state.status.startsWith('Saw placeholder ')
      && state.data.useAutomation) {
    console.log('restarting...');
    state.start();
  }
}

/** Triggered from a command. */
window.plugin.explore.tbd = function() {
  window.plugin.explore.state.status = 'Command not implemented';
}

/** Triggered from a command button. */
window.plugin.explore.toggle_exploring = function() {
  const state = window.plugin.explore.state;

  if (state.exploring) {
    state.stop();
  } else {
    state.start();
  }
}

/** Triggered from a command. */
window.plugin.explore.save = function() {
  window.plugin.explore.state.save();
}

/** Triggered from a command. */
window.plugin.explore.clear = function() {
  window.plugin.explore.state.clear();
}

/** Triggered from a command. */
window.plugin.explore.refresh = function() {
  window.plugin.explore.state.refreshLayers();
}

/** Triggered from a command. */
window.plugin.explore.use_view = function() {
  const state = window.plugin.explore.state;

  state.data.boundary = window.map.getBounds();
  state.status = 'Bounds set to current view';
}

/** Triggered from a command. */
window.plugin.explore.extend_view = function() {
  const state = window.plugin.explore.state;

  state.data.extendBoundary(window.map.getBounds());
  state.status = 'Bounds now includes current view';
}

/** Triggered from a command. */
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

/** Triggered from a command. */
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

/**
 * Triggered from a command.
 * @param {Event} evt - Triggering event.
 */
window.plugin.explore.toggle_notifications = function(evt) {
  const state = window.plugin.explore.state;

  if (evt.type === 'change') {
    if (evt.target.checked) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then((permission) => {
          if (Notification.permission === 'denied') {
            evt.target.checked = false;
            evt.target.disabled = true;
            state.data.useNotifications = evt.target.checked;
          }
        });
      }
    }
    state.data.useNotifications = evt.target.checked;
  }
}

/**
 * Triggered from a command.
 * @param {Event} evt - Triggering event.
 */
window.plugin.explore.toggle_automation = function(evt) {
  const state = window.plugin.explore.state;

  if (evt.type === 'change') {
    state.data.useAutomation = evt.target.checked;
  }
}

/** Opens the dialog/dashboard. */
window.plugin.explore.central = function() {
  const explore = window.plugin.explore;

  const commands = [
    {elem: 'button', label: 'Toggle Exploring', func: explore.toggle_exploring},
    {elem: 'button', label: 'Save Exploration', func: explore.save},
    {elem: 'button', label: 'Clear Exploration', func: explore.clear},
    {elem: 'button', label: 'Refresh Explored View', func: explore.refresh},
    {elem: 'button', label: 'Set Boundary from View', func: explore.use_view},
    {elem: 'button', label: 'Extend Boundary to View', func: explore.extend_view},
  ];
  if (window.plugin.drawTools) {
    commands.push({
      elem: 'button',
      label: 'Set boundary from DrawTools',
      func: explore.use_drawtools,
    });
  }
  if (window.plugin.bookmarks) {
    commands.push({
      elem: 'button',
      label: 'Set boundary from Bookmarks',
      func: explore.use_bookmarks,
    });
  }
  if (Notification.permission !== 'granted') {
    explore.state.data.useNotifications = false;
  }
  const notify_config = {
    type: 'checkbox',
    checked: explore.state.data.useNotifications,
    disabled: !window.Notification || Notification.permission === 'denied',
  };
  commands.push({
    elem: 'label',
    post_create: (elem) => explore._prependInput(
      elem, notify_config, explore.toggle_notifications),
    label: 'Allow notifications',
    func: explore.toggle_notifications,
  });
  const automation_config = {
    type: 'checkbox',
    checked: explore.state.data.useAutomation,
  };
  commands.push({
    elem: 'label',
    post_create: (elem) => explore._prependInput(
      elem, automation_config, explore.toggle_automation),
    label: 'Enable full automation',
    func: explore.toggle_automation,
  });

  const html = `<div class='button-menu'>
    </div>`;
  const dia = dialog({
    title: 'Explore Central',
    id: 'explore-central',
    html: html,
  });
  const div = dia.find('div');
  for (const item of commands) {
    const wrapper = document.createElement('div');
    const elem = document.createElement(item.elem);
    elem.innerText = item.label;
    if (item.post_create) {
      item.post_create(elem);
    }
    elem.addEventListener('click', item.func);
    wrapper.append(elem);
    div.append(wrapper);
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
}

/** Called when IITC is fully loaded. */
window.plugin.explore.iitcLoaded = function() {
  window.plugin.explore.state = new window.plugin.explore.State();
  window.addHook('mapDataRefreshEnd', window.plugin.explore.dataRefreshed);
  window.addHook(
    'portalDetailsUpdated', window.plugin.explore.portalDetailsUpdated);
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
