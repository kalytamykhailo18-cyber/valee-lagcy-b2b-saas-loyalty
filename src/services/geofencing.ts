import prisma from '../db/client.js';

/**
 * Haversine formula: compute straight-line distance between two GPS points in km.
 */
export function haversineDistanceKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface GeofenceCheckResult {
  plausible: boolean;
  distanceKm: number;
  elapsedMinutes: number;
  impliedSpeedKmh: number;
  maxSpeedKmh: number;
  reason?: string;
}

/**
 * Check if a consumer's location is geographically plausible
 * given the merchant's location and the invoice timestamp.
 *
 * Returns plausible=true if:
 * - Either set of coordinates is missing (no penalty for missing data)
 * - The implied speed is within the configured threshold
 *
 * Returns plausible=false if:
 * - The implied speed exceeds the threshold (physically impossible)
 */
export async function checkGeofence(params: {
  consumerLat: number | null;
  consumerLon: number | null;
  tenantId: string;
  branchId?: string | null;
  invoiceTimestamp: Date | null;
}): Promise<GeofenceCheckResult> {
  const maxSpeedKmh = parseFloat(process.env.GEO_MAX_SPEED_KMH || '200');

  // If consumer coordinates are missing, no penalty
  if (params.consumerLat === null || params.consumerLon === null) {
    return { plausible: true, distanceKm: 0, elapsedMinutes: 0, impliedSpeedKmh: 0, maxSpeedKmh };
  }

  // Get merchant/branch coordinates
  let merchantLat: number | null = null;
  let merchantLon: number | null = null;

  if (params.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: params.branchId } });
    if (branch?.latitude && branch?.longitude) {
      merchantLat = Number(branch.latitude);
      merchantLon = Number(branch.longitude);
    }
  }

  // If no branch coordinates, try tenant-level branches
  if (merchantLat === null || merchantLon === null) {
    const branch = await prisma.branch.findFirst({
      where: { tenantId: params.tenantId, active: true, latitude: { not: null } },
    });
    if (branch?.latitude && branch?.longitude) {
      merchantLat = Number(branch.latitude);
      merchantLon = Number(branch.longitude);
    }
  }

  // If no merchant coordinates available, can't check
  if (merchantLat === null || merchantLon === null) {
    return { plausible: true, distanceKm: 0, elapsedMinutes: 0, impliedSpeedKmh: 0, maxSpeedKmh };
  }

  // If no invoice timestamp, can't check time component
  if (!params.invoiceTimestamp) {
    return { plausible: true, distanceKm: 0, elapsedMinutes: 0, impliedSpeedKmh: 0, maxSpeedKmh };
  }

  const distanceKm = haversineDistanceKm(
    merchantLat, merchantLon,
    params.consumerLat, params.consumerLon
  );

  const elapsedMs = Date.now() - params.invoiceTimestamp.getTime();
  const elapsedMinutes = elapsedMs / (1000 * 60);
  const elapsedHours = elapsedMinutes / 60;

  // Avoid division by zero — if less than 1 minute elapsed, use 1 minute
  const effectiveHours = Math.max(elapsedHours, 1 / 60);
  const impliedSpeedKmh = distanceKm / effectiveHours;

  if (impliedSpeedKmh > maxSpeedKmh) {
    return {
      plausible: false,
      distanceKm: Math.round(distanceKm * 100) / 100,
      elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
      impliedSpeedKmh: Math.round(impliedSpeedKmh),
      maxSpeedKmh,
      reason: `Distance ${distanceKm.toFixed(1)} km in ${elapsedMinutes.toFixed(0)} min implies ${impliedSpeedKmh.toFixed(0)} km/h (max: ${maxSpeedKmh} km/h)`,
    };
  }

  return {
    plausible: true,
    distanceKm: Math.round(distanceKm * 100) / 100,
    elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
    impliedSpeedKmh: Math.round(impliedSpeedKmh),
    maxSpeedKmh,
  };
}
