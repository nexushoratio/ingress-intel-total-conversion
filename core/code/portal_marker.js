/* global IITC, L, log -- eslint */

/**
 * @file This file contains the code related to creating and updating portal markers on the map.
 * @module portal_marker
 */

// portal hooks
function handler_portal_click(e) {
  window.selectPortal(e.target.options.guid, e.type);
  window.renderPortalDetails(e.target.options.guid);
}

function handler_portal_dblclick(e) {
  window.selectPortal(e.target.options.guid, e.type);
  window.renderPortalDetails(e.target.options.guid);
  window.map.setView(e.target.getLatLng(), window.DEFAULT_ZOOM);
}

function handler_portal_contextmenu(e) {
  window.selectPortal(e.target.options.guid, e.type);
  window.renderPortalDetails(e.target.options.guid);
  if (window.isSmartphone()) {
    window.show('info');
  } else if (!$('#scrollwrapper').is(':visible')) {
    $('#sidebartoggle').click();
  }
}

L.PortalMarker = L.CircleMarker.extend({
  options: {},

  statics: {
    // base style
    portalBaseStyle: {
      stroke: true,
      opacity: 1,
      fill: true,
      fillOpacity: 0.5,
      interactive: true,
    },
    // placeholder style
    placeholderStyle: {
      dashArray: '1,2',
      weight: 1,
    },
    // portal level   0  1  2  3  4  5  6  7  8
    LEVEL_TO_WEIGHT: [2, 2, 2, 2, 2, 3, 3, 4, 4],
    LEVEL_TO_RADIUS: [7, 7, 7, 7, 8, 8, 9, 10, 11],
  },

  initialize: function (latlng, data) {
    L.CircleMarker.prototype.initialize.call(this, latlng);
    this._selected = data.guid === window.selectedPortal;
    this.updateDetails(data);

    this.on('click', handler_portal_click);
    this.on('dblclick', handler_portal_dblclick);
    this.on('contextmenu', handler_portal_contextmenu);
  },

  willUpdate: function (details) {
    // details are from a placeholder
    if (details.level === undefined) {
      // if team differs and corresponding link is more recent (ignore field)
      return this._details.timestamp < details.timestamp && this._details.team !== details.team;
    }
    // more recent timestamp, this occurs when the data has changed because of:
    //  - resonator deploy/upgrade
    //  - mod deploy
    //  - recharge/damage/decay
    //  - portal edit (title, location, portal main picture)
    if (this._details.timestamp < details.timestamp) {
      return true;
    }
    // current marker is a placeholder, and details is real data
    if (this.isPlaceholder() && this._details.team === details.team) {
      return true;
    }
    // even if we get history that was missing ? is it even possible ?
    if (this._details.timestamp > details.timestamp) {
      return false;
    }

    // this._details.timestamp === details.timestamp

    // get new history
    if (details.history) {
      if (!this._details.history) {
        return true;
      }
      if (this._details.history._raw !== details.history._raw) {
        return true;
      }
    }

    // get details portal data
    if (!this._details.mods && details.mods) {
      return true;
    }

    return false;
  },

  updateDetails: function (details) {
    if (this._details) {
      // portal has been moved
      if (this._details.latE6 !== details.latE6 || this._details.lngE6 !== details.lngE6) {
        this.setLatLng(L.latLng(details.latE6 / 1e6, details.lngE6 / 1e6));
      }

      // core data from a placeholder
      if (details.level === undefined) {
        // if team has changed
        if (this._details.timestamp < details.timestamp && this._details.team !== details.team) {
          // keep history, title, image
          details.title = this._details.title;
          details.image = this._details.image;
          details.history = this._details.history;
          this._details = details;
        }
      } else if (this._details.timestamp === details.timestamp) {
        // we got more details (core/summary -> summary/detailed/extended)
        var localThis = this;
        [
          'level',
          'health',
          'resCount',
          'image',
          'title',
          'ornaments',
          'mission',
          'mission50plus',
          'artifactBrief',
          'mods',
          'resonators',
          'owner',
          'artifactDetail',
        ].forEach(function (prop) {
          if (details[prop]) localThis._details[prop] = details[prop];
        });
        // smarter update for history (cause it's missing sometimes)
        if (details.history) {
          if (!this._details.history) {
            this._details.history = details.history;
          } else {
            if (this._details.history._raw && details.history._raw !== this._details.history._raw) {
              log.warn('new portal data has lost some history');
            }
            this._details.history._raw |= details.history._raw;
            ['visited', 'captured', 'scoutControlled'].forEach(function (prop) {
              localThis._details.history[prop] ||= details.history[prop];
            });
          }
        }
        // LEGACY - TO BE REMOVED AT SOME POINT! use .guid, .timestamp and .data instead
        this._details.ent = details.ent;
      } else {
        // permanent data (history only)
        if (!details.history) {
          details.history = this._details.history;
        }

        this._details = details;
      }
    } else {
      this._details = details;
    }

    this._level = parseInt(this._details.level) || 0;
    this._team = IITC.utils.getTeamId(this._details.team);

    // the data returns unclaimed portals as level 1 - but IITC wants them treated as level 0
    if (this._team === window.TEAM_NONE) {
      this._level = 0;
    }

    // compatibility
    var dataOptions = {
      guid: this._details.guid,
      level: this._level,
      team: this._team,
      ent: this._details.ent, // LEGACY - TO BE REMOVED AT SOME POINT! use .guid, .timestamp and .data instead
      timestamp: this._details.timestamp,
      data: this._details,
    };
    L.setOptions(this, dataOptions);

    this.setSelected();
    if (this.hasFullDetails()) {
      window.portalDetail.store(this.options.guid, this._details);
    }
  },

  getDetails: function () {
    return this._details;
  },

  isPlaceholder: function () {
    return this._details.level === undefined;
  },

  hasFullDetails: function () {
    return !!this._details.mods;
  },

  setStyle: function (style) {
    // stub for highlighters
    L.Util.setOptions(this, style);
    return this;
  },

  setMarkerStyle: function (style) {
    var styleOptions = L.Util.extend(this._style(), style);
    L.Util.setOptions(this, styleOptions);

    L.Util.setOptions(this, window.highlightPortal(this));

    var selected = L.extend({ radius: this.options.radius }, this._selected && { color: window.COLOR_SELECTED_PORTAL });
    return L.CircleMarker.prototype.setStyle.call(this, selected);
  },

  setSelected: function (selected) {
    if (selected === false) {
      this._selected = false;
    } else {
      this._selected = this._selected || selected;
    }

    this.setMarkerStyle();

    if (this._selected && window.map.hasLayer(this)) {
      this.bringToFront();
    }
  },

  _style: function () {
    var dashArray = null;
    // dashed outline for placeholder portals
    if (this.isPlaceholder()) {
      dashArray = L.PortalMarker.placeholderStyle.dashArray;
    }

    return L.extend(this._scale(), L.PortalMarker.portalBaseStyle, {
      color: window.COLORS[this._team],
      fillColor: window.COLORS[this._team],
      dashArray: dashArray,
    });
  },

  _scale: function () {
    var scale = window.portalMarkerScale();

    var level = Math.floor(this._level || 0);

    var lvlWeight = L.PortalMarker.LEVEL_TO_WEIGHT[level] * Math.sqrt(scale);
    var lvlRadius = L.PortalMarker.LEVEL_TO_RADIUS[level] * scale;

    // thinner outline for placeholder portals
    if (this.isPlaceholder()) {
      lvlWeight = L.PortalMarker.placeholderStyle.weight;
    }

    return {
      radius: lvlRadius,
      weight: lvlWeight,
    };
  },
});

/**
 * Calculates the scale of portal markers based on the current zoom level of the map.
 *
 * @function portalMarkerScale
 * @returns {number} The scale factor for portal markers.
 */
window.portalMarkerScale = function () {
  var zoom = window.map.getZoom();
  if (L.Browser.mobile) return zoom >= 16 ? 1.5 : zoom >= 14 ? 1.2 : zoom >= 11 ? 1.0 : zoom >= 8 ? 0.65 : 0.5;
  else return zoom >= 14 ? 1 : zoom >= 11 ? 0.8 : zoom >= 8 ? 0.65 : 0.5;
};

/**
 * Creates a new portal marker on the map.
 *
 * @function createMarker
 * @param {L.LatLng} latlng - The latitude and longitude where the marker will be placed.
 * @param {Object} data - The IITC-specific entity data to be stored in the marker options.
 * @returns {L.PortalMarker} A Leaflet circle marker representing the portal.
 */
window.createMarker = function (latlng, data) {
  return new L.PortalMarker(latlng, data);
};

/**
 * Sets the style of a portal marker, including options for when the portal is selected.
 *
 * @function setMarkerStyle
 * @param {L.PortalMarker} marker - The portal marker whose style will be set.
 * @param {boolean} selected - Indicates if the portal is selected.
 */
window.setMarkerStyle = function (marker, selected) {
  marker.setSelected(selected);
};

/**
 * Determines the style options for a portal marker based on its details.
 *
 * @function getMarkerStyleOptions
 * @param {Object} details - Details of the portal, including team and level.
 * @returns {Object} Style options for the portal marker.
 */
window.getMarkerStyleOptions = function (details) {
  var scale = window.portalMarkerScale();

  var level = Math.floor(details.level || 0);

  var lvlWeight = L.PortalMarker.LEVEL_TO_WEIGHT[level] * Math.sqrt(scale);
  var lvlRadius = L.PortalMarker.LEVEL_TO_RADIUS[level] * scale;

  var dashArray = null;
  // thinner and dashed outline for placeholder portals
  if (details.team !== window.TEAM_NONE && level === 0) {
    lvlWeight = L.PortalMarker.placeholderStyle.weight;
    dashArray = L.PortalMarker.placeholderStyle.dashArray;
  }

  var options = L.extend(
    {
      radius: lvlRadius,
      weight: lvlWeight,
    },
    L.PortalMarker.portalBaseStyle,
    {
      color: window.COLORS[details.team],
      fillColor: window.COLORS[details.team],
      dashArray: dashArray,
    }
  );

  return options;
};
