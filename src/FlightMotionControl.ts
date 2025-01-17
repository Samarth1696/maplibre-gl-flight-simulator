import { type IControl, type Map, LngLat } from 'maplibre-gl';

/*
 * Approximate radius of the earth in meters.
 * Uses the WGS-84 approximation: https://en.wikipedia.org/wiki/World_Geodetic_System#WGS84
 */
const earthRadius = 6371008.8;

interface MotionState {
    position: {
        lat: number;
        lng: number;
        altitude: number;
    };
    attitude: {
        heading: number;
        pitch: number;
        roll: number;
    };
    velocity: {
        groundSpeed: number;     // Not explicitly used during prediction, but stored
        verticalSpeed: number;   // Not explicitly used during prediction, but stored
    };
}

interface CameraMode {
    type: 'COCKPIT' | 'CHASE' | 'ORBIT' | 'FREE';
    offset?: {
        x: number;
        y: number;
        z: number;
    };
    orientation?: {
        heading: number;
        pitch: number;
        roll: number;
    };
}

interface MovementInterpolation {
    start: MotionState;
    target: MotionState;
    remainingFrames: number;
    // Pre-calculated per-frame deltas
    deltas: {
        lat: number;
        lng: number;
        altitude: number;
        heading: number;
        pitch: number;
        roll: number;
        groundSpeed: number;
        verticalSpeed: number;
    };
}

export class FlightMotionControl implements IControl {
    _map: Map;
    _container: HTMLElement;

    // Update loop
    _updateInterval: number | null = null;
    private readonly FRAME_INTERVAL = 16; // 16ms

    // Motion states
    _currentState: MotionState | null = null;
    _previousState: MotionState | null = null;
    _interpolationState: MotionState | null = null;
    _currentInterpolation: MovementInterpolation | null = null;

    // Time trackers
    _lastUpdateTime: number = 0;
    private _lastFrameTime: number = performance.now();

    // derivative-calc cooldown
    private _lastDerivativeCalcTime = 0;

    // Disposal
    _disposed: boolean = false;

    // Prediction toggles
    predict: boolean = false;
    shouldPredict: boolean = false; // optional usage

    // Derived velocities
    _velocity = { x: 0, y: 0, z: 0 }; // m/s in each axis (east-x, north-y, up-z)
    _angularVelocity = { heading: 0, pitch: 0, roll: 0 }; // deg/s

    // Config
    private readonly FRAMES: number; // number of interpolation frames to break transitions
    private readonly MINIMUM_FRAMES: number;

    _cameraMode: CameraMode = {
        type: 'COCKPIT',
        offset: { x: 0, y: -30, z: 10 },
        orientation: { heading: 0, pitch: 0, roll: 0 }
    };

    // Bound function to avoid extra references
    private readonly _boundUpdateFrame: () => void;

    constructor(options: {
        initialPosition?: {
            lat: number;
            lng: number;
            altitude: number;
        };
        cameraMode?: CameraMode;
        predict?: boolean;
        minimumFrames?: number; // User configurable minimum frames
        frames?: number;       // User configurable number of interpolation frames
    } = {}) {
        this.MINIMUM_FRAMES = options.minimumFrames ?? 3; // Default to 3
        this.FRAMES = options.frames ?? 60;            // Default to 60

        // Bind loop callback
        this._boundUpdateFrame = this._updateFrame.bind(this);
        this._lastUpdateTime = performance.now();

        if (options.initialPosition) {
            this._currentState = {
                position: {
                    lat: options.initialPosition.lat,
                    lng: options.initialPosition.lng,
                    altitude: options.initialPosition.altitude
                },
                attitude: {
                    heading: 0,
                    pitch: 0,
                    roll: 0
                },
                velocity: {
                    groundSpeed: 0,
                    verticalSpeed: 0
                }
            };
        }

        if (options.cameraMode) {
            this._cameraMode = {
                ...options.cameraMode,
                offset: options.cameraMode.offset || { x: 0, y: 0, z: 0 },
                orientation: options.cameraMode.orientation || { heading: 0, pitch: 0, roll: 0 }
            };
        }

        if (options.predict) {
            this.shouldPredict = true;
        }
    }

    onAdd(map: Map): HTMLElement {
        this._map = map;

        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl';

        // Disable map interactions
        this._map.dragRotate.disable();
        this._map.touchZoomRotate.disableRotation();
        this._map.keyboard.disable();

        // Some optional performance tweaks
        this._map._fadeDuration = 0;
        this._map._maxTileCacheSize = 8;

        this._startUpdate();

        return this._container;
    }

    onRemove(): void {
        this._dispose();
    }

    _dispose(): void {
        if (this._disposed) return;

        this._stopUpdate();

        if (this._container?.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }

        if (this._map) {
            // Re-enable map interactions
            this._map.dragRotate.enable();
            this._map.touchZoomRotate.enableRotation();
            this._map.keyboard.enable();
        }

        // Clear references
        this._container = null;
        this._map = null;
        this._currentState = null;
        this._currentInterpolation = null;

        this._disposed = true;
    }

    _startUpdate(): void {
        this._stopUpdate();
        if (!this._disposed) {
            this._updateInterval = window.setInterval(this._boundUpdateFrame, this.FRAME_INTERVAL);
        }
    }

    _stopUpdate(): void {
        if (this._updateInterval !== null) {
            window.clearInterval(this._updateInterval);
            this._updateInterval = null;
        }
    }

    /**
     * Main update loop, called after every 16ms.
     * We compute a per-frame deltaTime, then either predict or interpolate.
     */
    _updateFrame(): void {
        if (this._disposed || !this._map) return;

        // Calculate time since last frame in seconds
        const now = performance.now();
        const deltaTimeSec = (now - this._lastFrameTime) / 1000;
        this._lastFrameTime = now;

        if (this.predict) {
            // Prediction mode: move the flight by _velocity + _angularVelocity
            this._predictMovement(deltaTimeSec);
        } else {
            // Interpolation mode: step towards the last updated flight state from server
            this._interpolateFrame();
        }
    }

    /**
     * Called by external code to update flight state with new data (e.g. from server).
     * If not in prediction mode, we do standard interpolation to smoothly animate changes.
     */
    updateFlightState(state: {
        lat?: number;
        lng?: number;
        elevation?: number;
        flightHeading?: number;
        groundSpeed?: number;
        verticalSpeed?: number;
        pitchAttitude?: number;
        rollAttitude?: number;
    }): void {
        if (!this._map) return;
        const now = performance.now();
        const deltaTime = now - this._lastUpdateTime;
        this._lastUpdateTime = now;

        // Build new state from passed data or existing fallback
        const newState: MotionState = {
            position: {
                lat: state.lat ?? (this._currentState?.position.lat ?? this._map.transform.getCameraLngLat().lat),
                lng: state.lng ?? (this._currentState?.position.lng ?? this._map.transform.getCameraLngLat().lng),
                altitude: state.elevation ?? (this._currentState?.position.altitude ?? this._map.transform.getCameraAltitude())
            },
            attitude: {
                heading: state.flightHeading ?? (this._currentState?.attitude.heading ?? 0),
                pitch: state.pitchAttitude ?? (this._currentState?.attitude.pitch ?? 0),
                roll: state.rollAttitude ?? (this._currentState?.attitude.roll ?? 0)
            },
            velocity: {
                groundSpeed: state.groundSpeed ?? (this._currentState?.velocity.groundSpeed ?? 0),
                verticalSpeed: state.verticalSpeed ?? (this._currentState?.velocity.verticalSpeed ?? 0)
            }
        };

        // Keep track of old state for derivative calculations
        this._previousState = this._currentState ? { ...this._currentState } : null;

        // Update the current state
        this._currentState = newState;

        // Initialize interpolation state if needed
        if (!this._interpolationState) {
            this._interpolationState = { ...newState };
            return;
        }

        // Number of frames over which to interpolate
        let frames = Math.round((deltaTime / 1000) * this.FRAMES);
        frames = Math.max(frames, this.MINIMUM_FRAMES);

        // Pre-calculate deltas
        const deltas = {
            lat: (newState.position.lat - this._interpolationState.position.lat) / frames,
            lng: this._calculateShortestLongitudeDelta(
                this._interpolationState.position.lng,
                newState.position.lng
            ) / frames,
            altitude: (newState.position.altitude - this._interpolationState.position.altitude) / frames,
            heading: this._calculateShortestAngleDelta(
                this._interpolationState.attitude.heading,
                newState.attitude.heading
            ) / frames,
            pitch: (newState.attitude.pitch - this._interpolationState.attitude.pitch) / frames,
            roll: this._calculateShortestAngleDelta(
                this._interpolationState.attitude.roll,
                newState.attitude.roll
            ) / frames,
            groundSpeed: (newState.velocity.groundSpeed - this._interpolationState.velocity.groundSpeed) / frames,
            verticalSpeed: (newState.velocity.verticalSpeed - this._interpolationState.velocity.verticalSpeed) / frames
        };

        // Setup interpolation
        this._currentInterpolation = {
            start: { ...this._interpolationState },
            target: { ...newState },
            remainingFrames: frames,
            deltas
        };

        // Optionally update velocities for prediction usage
        // (If you want to keep the real-time velocity for your flight model)
        // The motion derviatives will update at every 5 seconds.
        if (this.shouldPredict && this._previousState) {
            const timeSinceLastDerivCalc = now - this._lastDerivativeCalcTime;
            if (timeSinceLastDerivCalc >= 5000) {
                this._updateMotionDerivatives(deltaTime / 1000);

                // reset timer
                this._lastDerivativeCalcTime = now;
            }
        }
    }

    /**
     * Derive _velocity + _angularVelocity from changes in the flight state.
     * Called after the server updates flight state, so we have a local estimate for prediction.
     */
    _updateMotionDerivatives(deltaTime: number) {
        if (!this._previousState || !this._currentState) return;

        const prev = this._previousState;
        const curr = this._currentState;

        // Approx. meters per degree of latitude
        const metersPerDegree = 110574.3;

        // Position deltas
        const cosLat = Math.cos(curr.position.lat * Math.PI / 180);
        const dx = (curr.position.lng - prev.position.lng) * cosLat * metersPerDegree;
        const dy = (curr.position.lat - prev.position.lat) * metersPerDegree;
        const dz = curr.position.altitude - prev.position.altitude;

        // Instantaneous velocity in x, y, z (m/s)
        this._velocity.x = dx / deltaTime;
        this._velocity.y = dy / deltaTime;
        this._velocity.z = dz / deltaTime;

        // Angular deltas
        const dHeading = this._calculateShortestAngleDelta(prev.attitude.heading, curr.attitude.heading);
        const dPitch = curr.attitude.pitch - prev.attitude.pitch;
        const dRoll = curr.attitude.roll - prev.attitude.roll;

        // Angular velocities (deg/s)
        this._angularVelocity.heading = dHeading / deltaTime;
        this._angularVelocity.pitch = dPitch / deltaTime;
        this._angularVelocity.roll = dRoll / deltaTime;
    }

    /**
     * Predictive movement: apply _velocity (m/s) and _angularVelocity (deg/s) to the current flight state.
     */
    private _predictMovement(deltaTime: number): void {
        if (!this._currentState) return;

        const { lat, lng, altitude } = this._currentState.position;
        const metersPerDegree = 110574.3;
        // Avoid division by zero if near poles
        const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 1e-9);

        // Position changes
        const dLat = (this._velocity.y * deltaTime) / metersPerDegree;
        const dLng = (this._velocity.x * deltaTime) / (metersPerDegree * cosLat);
        const dAlt = this._velocity.z * deltaTime;

        this._currentState.position.lat += dLat;
        this._currentState.position.lng += dLng;
        this._currentState.position.altitude += dAlt;

        // Attitude changes
        this._currentState.attitude.heading =
            (this._currentState.attitude.heading + this._angularVelocity.heading * deltaTime + 360) % 360;
        this._currentState.attitude.pitch += this._angularVelocity.pitch * deltaTime;
        this._currentState.attitude.roll =
            (this._currentState.attitude.roll + this._angularVelocity.roll * deltaTime + 360) % 360;

        // Now update camera based on the newly updated _currentState
        this._updateCamera();
    }

    /**
     * If not predicting, we interpolate across a fixed number of frames toward the latest flight state.
     */
    private _interpolateFrame(): void {
        // If there's no interpolation in progress, just update the camera from the existing state
        if (!this._currentInterpolation || !this._interpolationState) {
            this._updateCamera();
            return;
        }

        if (this._currentInterpolation.remainingFrames <= 0) {
            // Finalize interpolation
            this._interpolationState = { ...this._currentInterpolation.target };
            this._currentInterpolation = null;
        } else {
            // Step forward by the precomputed deltas
            this._interpolationState = {
                position: {
                    lat: this._interpolationState.position.lat + this._currentInterpolation.deltas.lat,
                    lng: this._interpolationState.position.lng + this._currentInterpolation.deltas.lng,
                    altitude: this._interpolationState.position.altitude + this._currentInterpolation.deltas.altitude
                },
                attitude: {
                    heading: (this._interpolationState.attitude.heading + this._currentInterpolation.deltas.heading + 360) % 360,
                    pitch: this._interpolationState.attitude.pitch + this._currentInterpolation.deltas.pitch,
                    roll: (this._interpolationState.attitude.roll + this._currentInterpolation.deltas.roll + 360) % 360
                },
                velocity: {
                    groundSpeed: this._interpolationState.velocity.groundSpeed + this._currentInterpolation.deltas.groundSpeed,
                    verticalSpeed: this._interpolationState.velocity.verticalSpeed + this._currentInterpolation.deltas.verticalSpeed
                }
            };

            this._currentInterpolation.remainingFrames--;
        }

        this._updateCamera();
    }

    /**
     * Updates the map camera from whichever state is active:
     *  - If predicting, we use _currentState
     *  - If interpolating, we use _interpolationState
     */
    _updateCamera(): void {
        if (!this._map) return;

        // If in prediction, the new flight position is in _currentState
        // If not predicting, we rely on the incremental interpolation state
        const stateToUse = this.predict ? this._currentState : this._interpolationState;
        if (!stateToUse) return;

        const cameraPosition = this._calculateCameraPosition(stateToUse);
        if (!cameraPosition) return;

        const { camPos, camAlt, heading, pitch, roll } = cameraPosition;
        const jumpToOptions = this._map.calculateCameraOptionsFromCameraLngLatAltRotation(
            camPos,
            camAlt,
            heading,
            pitch,
            roll
        );
        this._map.jumpTo(jumpToOptions);
    }

    /**
     * Calculate how to position the camera based on the current mode (cockpit, chase, orbit, free).
     */
    _calculateCameraPosition(state: MotionState): {
        camPos: LngLat;
        camAlt: number;
        heading: number;
        pitch: number;
        roll: number;
    } | null {
        if (!state) return null;

        const mode = this._cameraMode;
        let camPos: LngLat;
        let camAlt: number;
        let heading: number;
        let pitch: number;
        let roll: number;

        // Helper for converting flight pitch to camera pitch
        const convertPitch = (flightPitch: number): number => {
            // clamp flight pitch to [-90, 90]
            const clamped = Math.max(-90, Math.min(90, flightPitch));
            // flight pitch 0 => camera pitch 90 (looking forward)
            // flight pitch +90 => camera pitch 0 (looking down)
            // flight pitch -90 => camera pitch 180 (looking up)
            return 90 - clamped;
        };

        switch (mode.type) {
            case 'COCKPIT':
                // Directly on the aircraft, offset for pilot's perspective
                camPos = new LngLat(state.position.lng, state.position.lat);
                camAlt = state.position.altitude + (mode.offset?.z ?? 0);
                heading = state.attitude.heading;
                pitch = convertPitch(state.attitude.pitch);
                roll = state.attitude.roll;
                break;

            case 'CHASE': {
                // Chase camera behind the aircraft
                const offsetMeters = this._calculateChaseOffset(mode.offset ?? { x: 0, y: -30, z: 10 });
                camPos = this._offsetPosition(
                    state.position.lat,
                    state.position.lng,
                    state.attitude.heading,
                    offsetMeters.x,
                    offsetMeters.y
                );
                camAlt = state.position.altitude + offsetMeters.z;
                heading = state.attitude.heading;
                pitch = convertPitch(state.attitude.pitch * 0.5);
                roll = state.attitude.roll * 0.5;
                break;
            }

            case 'ORBIT': {
                // Orbiting around the aircraft
                const orbitAngle = (performance.now() % 30000) / 30000 * Math.PI * 2;
                const radius = Math.sqrt((mode.offset?.y ?? 100) ** 2 + (mode.offset?.x ?? 0) ** 2);
                const orbitX = Math.cos(orbitAngle) * radius;
                const orbitY = Math.sin(orbitAngle) * radius;

                camPos = this._offsetPosition(state.position.lat, state.position.lng, 0, orbitX, orbitY);
                camAlt = state.position.altitude + (mode.offset?.z ?? 50);

                heading = this._calculateHeadingToPoint(
                    camPos.lat, camPos.lng,
                    state.position.lat, state.position.lng
                );
                pitch = this._calculatePitchToPoint(
                    camPos.lat, camPos.lng, camAlt,
                    state.position.lat, state.position.lng, state.position.altitude
                );
                roll = 0;
                break;
            }

            case 'FREE':
            default:
                // Manual orientation
                camPos = new LngLat(state.position.lng, state.position.lat);
                camAlt = state.position.altitude;
                heading = mode.orientation?.heading ?? 0;
                pitch = mode.orientation?.pitch ?? 0;
                roll = mode.orientation?.roll ?? 0;
                break;
        }

        return { camPos, camAlt, heading, pitch, roll };
    }

    /**
     * Offsets the lat/lng by offsetX/Y meters, factoring in bearing.
     */
    _offsetPosition(lat: number, lng: number, bearing: number, offsetX: number, offsetY: number): LngLat {
        // Convert to radians and shift bearing
        const bearingRad = (bearing - 90) * Math.PI / 180;
        const R = earthRadius;

        const offsetBearing = Math.atan2(offsetY, offsetX);
        const offsetDistance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

        const lat1 = lat * Math.PI / 180;
        const lng1 = lng * Math.PI / 180;
        const bearing1 = bearingRad + offsetBearing;

        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(offsetDistance / R) +
            Math.cos(lat1) * Math.sin(offsetDistance / R) * Math.cos(bearing1)
        );
        const lng2 = lng1 + Math.atan2(
            Math.sin(bearing1) * Math.sin(offsetDistance / R) * Math.cos(lat1),
            Math.cos(offsetDistance / R) - Math.sin(lat1) * Math.sin(lat2)
        );

        return new LngLat((lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI);
    }

    /**
     * Calculate chase camera offset based on flight speed.
     */
    _calculateChaseOffset(baseOffset: { x: number; y: number; z: number }) {
        if (!this._currentState) return baseOffset;

        const speed = this._currentState.velocity.groundSpeed;
        const speedFactor = Math.min(speed / 100, 1); // scale factor

        return {
            x: baseOffset.x,
            y: baseOffset.y * (1 + speedFactor * 0.5),
            z: baseOffset.z * (1 + speedFactor * 0.3)
        };
    }

    _calculateHeadingToPoint(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
        const dLng = (toLng - fromLng) * Math.PI / 180;
        const fromLatRad = fromLat * Math.PI / 180;
        const toLatRad = toLat * Math.PI / 180;

        const y = Math.sin(dLng) * Math.cos(toLatRad);
        const x =
            Math.cos(fromLatRad) * Math.sin(toLatRad) -
            Math.sin(fromLatRad) * Math.cos(toLatRad) * Math.cos(dLng);

        return (Math.atan2(y, x) * 180) / Math.PI % 360;
    }

    _calculatePitchToPoint(
        fromLat: number, fromLng: number, fromAlt: number,
        toLat: number, toLng: number, toAlt: number
    ): number {
        const R = earthRadius;
        const dLat = (toLat - fromLat) * Math.PI / 180;
        const dLng = (toLng - fromLng) * Math.PI / 180;

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;
        const dAlt = toAlt - fromAlt;

        // negative sign so that upward is negative pitch
        return -Math.atan2(dAlt, distance) * (180 / Math.PI);
    }

    /**
     * Utility: shortest angle delta in [ -180, 180 ]
     */
    _calculateShortestAngleDelta(start: number, end: number): number {
        start = ((start % 360) + 360) % 360;
        end = ((end % 360) + 360) % 360;
        let delta = end - start;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    }

    /**
     * Utility: shortest longitude delta in [ -180, 180 ]
     */
    _calculateShortestLongitudeDelta(start: number, end: number): number {
        let delta = end - start;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    }

    /**
     * Set camera mode (COCKPIT, CHASE, ORBIT, FREE)
     */
    setCameraMode(mode: CameraMode): void {
        this._cameraMode = {
            ...mode,
            offset: mode.offset || { x: 0, y: 0, z: 0 },
            orientation: mode.orientation || { heading: 0, pitch: 0, roll: 0 }
        };

        if (mode.type === 'CHASE' && !mode.offset) {
            this._cameraMode.offset = { x: 0, y: -30, z: 10 };
        } else if (mode.type === 'ORBIT' && !mode.offset) {
            this._cameraMode.offset = { x: 0, y: -100, z: 50 };
        }
    }

    /**
     * Turn on prediction. Each frame, we apply _velocity + _angularVelocity to the flight.
     */
    startPrediction(): void {
        this.predict = true;
    }

    /**
     * Turn off prediction. Each frame, we go back to interpolation (if new states arrive) or remain static.
     */
    stopPrediction(): void {
        this.predict = false;
    }

    /**
     * Get the current flight state for debugging or external logic.
     */
    getState(): MotionState | null {
        return this._currentState ? { ...this._currentState } : null;
    }
}

