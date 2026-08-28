/**
 * Smart Pluggable Reverse Geocoder with Caching & Multi-Provider Support
 * Providers: OpenStreetMap (Default Free), Ola Maps (Ready for API Key), Google Maps
 */

class SmartGeocoder {
  constructor(options = {}) {
    this.provider = options.provider || process.env.GEOCODER_PROVIDER || 'osm'; // 'osm' | 'olamaps' | 'google'
    this.olaApiKey = options.olaApiKey || process.env.OLA_MAPS_API_KEY || '';
    this.googleApiKey = options.googleApiKey || process.env.GOOGLE_MAPS_API_KEY || '';
    
    // In-memory address cache: "lat_lng" -> { address, timestamp }
    this.cache = new Map();
    // Device last geocoded position: simNo -> { lat, lng, address, time }
    this.deviceLastGeo = new Map();
    
    this.maxCacheSize = 2000;
  }

  // Calculate distance between two coordinates in meters (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  getCacheKey(lat, lng) {
    // 3 decimal places is approx 110 meters accuracy
    return `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  }

  async getAddress(lat, lng, simNo = null) {
    if (!lat || !lng || (lat === 0 && lng === 0)) {
      return 'Unknown Location';
    }

    // 1. Check if device has moved less than 80 meters since last geocode
    if (simNo && this.deviceLastGeo.has(simNo)) {
      const last = this.deviceLastGeo.get(simNo);
      const dist = this.calculateDistance(lat, lng, last.lat, last.lng);
      if (dist < 80 && last.address) {
        return last.address;
      }
    }

    // 2. Check Coordinate Grid Cache
    const cacheKey = this.getCacheKey(lat, lng);
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24h cache
        if (simNo) this.deviceLastGeo.set(simNo, { lat, lng, address: cached.address, time: Date.now() });
        return cached.address;
      }
    }

    // 3. Fetch from Active Provider
    let address = null;

    // Check Ola Maps if API key is provided
    if (this.olaApiKey || process.env.OLA_MAPS_API_KEY) {
      address = await this._fetchOlaMaps(lat, lng);
    }

    // Fallback to Google Maps if configured
    if (!address && (this.googleApiKey || process.env.GOOGLE_MAPS_API_KEY)) {
      address = await this._fetchGoogleMaps(lat, lng);
    }

    // Default Fallback to OpenStreetMap (Free, Reliable)
    if (!address) {
      address = await this._fetchOpenStreetMap(lat, lng);
    }

    if (!address) {
      address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    // Store in Cache
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, { address, timestamp: Date.now() });

    if (simNo) {
      this.deviceLastGeo.set(simNo, { lat, lng, address, time: Date.now() });
    }

    return address;
  }

  // 1. OpenStreetMap Reverse Geocoding (Free)
  async _fetchOpenStreetMap(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TrackSphere-Dashcam-Server/1.0' },
        signal: AbortSignal.timeout(3500)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.display_name) {
        return this._formatCleanAddress(data);
      }
    } catch (e) {
      // Network timeout or fallback
    }
    return null;
  }

  // 2. Ola Maps Reverse Geocoding API (India Optimized)
  async _fetchOlaMaps(lat, lng) {
    const key = this.olaApiKey || process.env.OLA_MAPS_API_KEY;
    if (!key) return null;

    try {
      const url = `https://api.olamaps.io/places/v1/reverse-geocode?latlng=${lat},${lng}&api_key=${key}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        return data.results[0].formatted_address;
      }
    } catch (e) {
      console.warn('[OlaMaps Geocoder] Error:', e.message);
    }
    return null;
  }

  // 3. Google Maps Reverse Geocoding API
  async _fetchGoogleMaps(lat, lng) {
    const key = this.googleApiKey || process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return null;

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        return data.results[0].formatted_address;
      }
    } catch (e) {
      console.warn('[Google Geocoder] Error:', e.message);
    }
    return null;
  }

  _formatCleanAddress(data) {
    if (!data.address) return data.display_name;
    const a = data.address;
    const parts = [
      a.road || a.pedestrian || a.suburb || a.neighbourhood,
      a.city || a.town || a.village || a.county,
      a.state,
      a.postcode
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(', ') : data.display_name;
  }
}

module.exports = new SmartGeocoder();
