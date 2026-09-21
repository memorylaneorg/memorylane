import type { MediaDto } from "@memorylane/shared";

// Approximate offline "nearest major city" lookup for the subtle photo
// captions (e.g. "June 2007 · Chennai · 19 years ago"). This is deliberately
// not real reverse geocoding - MemoryLane is self-hosted and doesn't call
// external services with your photos' GPS coordinates, so a photo taken in a
// suburb will just get labeled with the nearest big city on this list. Good
// enough for a flavor caption, not meant to be precise.
const MAJOR_CITIES: { name: string; lat: number; lon: number }[] = [
  { name: "New York", lat: 40.7128, lon: -74.006 },
  { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { name: "Houston", lat: 29.7604, lon: -95.3698 },
  { name: "San Francisco", lat: 37.7749, lon: -122.4194 },
  { name: "Seattle", lat: 47.6062, lon: -122.3321 },
  { name: "Toronto", lat: 43.6532, lon: -79.3832 },
  { name: "Vancouver", lat: 49.2827, lon: -123.1207 },
  { name: "Mexico City", lat: 19.4326, lon: -99.1332 },
  { name: "Sao Paulo", lat: -23.5505, lon: -46.6333 },
  { name: "Rio de Janeiro", lat: -22.9068, lon: -43.1729 },
  { name: "Buenos Aires", lat: -34.6037, lon: -58.3816 },
  { name: "Lima", lat: -12.0464, lon: -77.0428 },
  { name: "Bogota", lat: 4.711, lon: -74.0721 },
  { name: "London", lat: 51.5074, lon: -0.1278 },
  { name: "Paris", lat: 48.8566, lon: 2.3522 },
  { name: "Berlin", lat: 52.52, lon: 13.405 },
  { name: "Madrid", lat: 40.4168, lon: -3.7038 },
  { name: "Barcelona", lat: 41.3851, lon: 2.1734 },
  { name: "Rome", lat: 41.9028, lon: 12.4964 },
  { name: "Milan", lat: 45.4642, lon: 9.19 },
  { name: "Amsterdam", lat: 52.3676, lon: 4.9041 },
  { name: "Brussels", lat: 50.8503, lon: 4.3517 },
  { name: "Zurich", lat: 47.3769, lon: 8.5417 },
  { name: "Vienna", lat: 48.2082, lon: 16.3738 },
  { name: "Prague", lat: 50.0755, lon: 14.4378 },
  { name: "Warsaw", lat: 52.2297, lon: 21.0122 },
  { name: "Stockholm", lat: 59.3293, lon: 18.0686 },
  { name: "Oslo", lat: 59.9139, lon: 10.7522 },
  { name: "Copenhagen", lat: 55.6761, lon: 12.5683 },
  { name: "Helsinki", lat: 60.1699, lon: 24.9384 },
  { name: "Dublin", lat: 53.3498, lon: -6.2603 },
  { name: "Lisbon", lat: 38.7223, lon: -9.1393 },
  { name: "Athens", lat: 37.9838, lon: 23.7275 },
  { name: "Moscow", lat: 55.7558, lon: 37.6173 },
  { name: "Istanbul", lat: 41.0082, lon: 28.9784 },
  { name: "Dubai", lat: 25.2048, lon: 55.2708 },
  { name: "Abu Dhabi", lat: 24.4539, lon: 54.3773 },
  { name: "Doha", lat: 25.2854, lon: 51.531 },
  { name: "Riyadh", lat: 24.7136, lon: 46.6753 },
  { name: "Tel Aviv", lat: 32.0853, lon: 34.7818 },
  { name: "Cairo", lat: 30.0444, lon: 31.2357 },
  { name: "Nairobi", lat: -1.2921, lon: 36.8219 },
  { name: "Lagos", lat: 6.5244, lon: 3.3792 },
  { name: "Johannesburg", lat: -26.2041, lon: 28.0473 },
  { name: "Cape Town", lat: -33.9249, lon: 18.4241 },
  { name: "Mumbai", lat: 19.076, lon: 72.8777 },
  { name: "Delhi", lat: 28.7041, lon: 77.1025 },
  { name: "Bengaluru", lat: 12.9716, lon: 77.5946 },
  { name: "Chennai", lat: 13.0827, lon: 80.2707 },
  { name: "Hyderabad", lat: 17.385, lon: 78.4867 },
  { name: "Kolkata", lat: 22.5726, lon: 88.3639 },
  { name: "Pune", lat: 18.5204, lon: 73.8567 },
  { name: "Ahmedabad", lat: 23.0225, lon: 72.5714 },
  { name: "Kochi", lat: 9.9312, lon: 76.2673 },
  { name: "Colombo", lat: 6.9271, lon: 79.8612 },
  { name: "Dhaka", lat: 23.8103, lon: 90.4125 },
  { name: "Karachi", lat: 24.8607, lon: 67.0011 },
  { name: "Lahore", lat: 31.5497, lon: 74.3436 },
  { name: "Kathmandu", lat: 27.7172, lon: 85.324 },
  { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
  { name: "Singapore", lat: 1.3521, lon: 103.8198 },
  { name: "Kuala Lumpur", lat: 3.139, lon: 101.6869 },
  { name: "Jakarta", lat: -6.2088, lon: 106.8456 },
  { name: "Manila", lat: 14.5995, lon: 120.9842 },
  { name: "Ho Chi Minh City", lat: 10.8231, lon: 106.6297 },
  { name: "Hanoi", lat: 21.0278, lon: 105.8342 },
  { name: "Hong Kong", lat: 22.3193, lon: 114.1694 },
  { name: "Shanghai", lat: 31.2304, lon: 121.4737 },
  { name: "Beijing", lat: 39.9042, lon: 116.4074 },
  { name: "Shenzhen", lat: 22.5431, lon: 114.0579 },
  { name: "Guangzhou", lat: 23.1291, lon: 113.2644 },
  { name: "Taipei", lat: 25.033, lon: 121.5654 },
  { name: "Seoul", lat: 37.5665, lon: 126.978 },
  { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
  { name: "Osaka", lat: 34.6937, lon: 135.5023 },
  { name: "Sydney", lat: -33.8688, lon: 151.2093 },
  { name: "Melbourne", lat: -37.8136, lon: 144.9631 },
  { name: "Brisbane", lat: -27.4698, lon: 153.0251 },
  { name: "Perth", lat: -31.9505, lon: 115.8605 },
  { name: "Auckland", lat: -36.8485, lon: 174.7633 },
  { name: "Honolulu", lat: 21.3069, lon: -157.8583 },
  { name: "Miami", lat: 25.7617, lon: -80.1918 },
  { name: "Atlanta", lat: 33.749, lon: -84.388 },
  { name: "Dallas", lat: 32.7767, lon: -96.797 },
  { name: "Denver", lat: 39.7392, lon: -104.9903 },
  { name: "Boston", lat: 42.3601, lon: -71.0589 },
  { name: "Washington", lat: 38.9072, lon: -77.0369 },
  { name: "Philadelphia", lat: 39.9526, lon: -75.1652 },
  { name: "Phoenix", lat: 33.4484, lon: -112.074 },
  { name: "Las Vegas", lat: 36.1699, lon: -115.1398 },
  { name: "Portland", lat: 45.5152, lon: -122.6784 },
  { name: "San Diego", lat: 32.7157, lon: -117.1611 },
  { name: "Montreal", lat: 45.5019, lon: -73.5674 },
];

const EARTH_RADIUS_KM = 6371;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Only label a photo with a city if it's plausibly nearby - otherwise a photo
// in the middle of nowhere would get a misleadingly specific-sounding label.
const MAX_CITY_DISTANCE_KM = 120;

function nearestCityName(lat: number, lon: number): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const city of MAJOR_CITIES) {
    const distance = haversineDistanceKm(lat, lon, city.lat, city.lon);
    if (!best || distance < best.distance) best = { name: city.name, distance };
  }
  return best && best.distance <= MAX_CITY_DISTANCE_KM ? best.name : null;
}

// "June 2007 · Chennai · 19 years ago" - each segment is optional depending
// on what metadata this particular photo has.
export function formatMemoryBlurb(media: Pick<MediaDto, "capturedDate" | "gpsLat" | "gpsLon">): string | null {
  const parts: string[] = [];

  let capturedYear: number | null = null;
  if (media.capturedDate) {
    const date = new Date(media.capturedDate);
    if (!Number.isNaN(date.getTime())) {
      parts.push(date.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
      capturedYear = date.getFullYear();
    }
  }

  if (media.gpsLat != null && media.gpsLon != null) {
    const city = nearestCityName(media.gpsLat, media.gpsLon);
    if (city) parts.push(city);
  }

  if (capturedYear !== null) {
    const yearsAgo = new Date().getFullYear() - capturedYear;
    if (yearsAgo >= 1) parts.push(`${yearsAgo} ${yearsAgo === 1 ? "year" : "years"} ago`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
