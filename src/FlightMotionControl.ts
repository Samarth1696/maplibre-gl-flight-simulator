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
        groundSpeed: number;
        verticalSpeed: number;
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
    _updateInterval: number | null = null;
    _currentState: MotionState | null = null;
    _previousState: MotionState | null = null;
    _currentInterpolation: MovementInterpolation | null = null;
    _lastUpdateTime: number = 0;
    _disposed: boolean = false;

    // prediction state vaiables
    predict: boolean = false;
    shouldPredict: boolean = false;
    _deltaIsCalculated: boolean = false;
    _currentDeltaTimeForPrediction: number;

    // Fixed frames configuration
    private readonly FRAMES = 20;
    private FRAME_INTERVAL = 16; // 16ms

    _velocity = { x: 0, y: 0, z: 0 };
    _angularVelocity = { heading: 0, pitch: 0, roll: 0 };

    _cameraMode: CameraMode = {
        type: 'COCKPIT',
        offset: { x: 0, y: -30, z: 10 },
        orientation: { heading: 0, pitch: 0, roll: 0 }
    };

    // Bind methods to avoid creating new function references
    private readonly _boundUpdateFrame: () => void;

    constructor(options: {
        initialPosition?: {
            lat: number;
            lng: number;
            altitude: number;
        };
        cameraMode?: CameraMode;
        predict?: boolean;
    } = {}) {
        // Bind update function once in constructor
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

        this._map.dragRotate.disable();
        this._map.touchZoomRotate.disableRotation();
        this._map.keyboard.disable();

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
            this._map.dragRotate.enable();
            this._map.touchZoomRotate.enableRotation();
            this._map.keyboard.enable();
        }

        // Clear all references
        this._container = null;
        this._map = null;
        this._currentState = null;
        this._currentInterpolation = null;

        // Mark as disposed
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

    _updateFrame(): void {
        // Skip update if disposed or missing dependencies
        if (this._disposed || !this._map) return;
        this._interpolateFrame();
    }

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
        const deltaTime = performance.now() - this._lastUpdateTime;

        this._previousState = this._currentState;
        // If no current state exists, initialize it
        if (!this._currentState) {
            this._currentState = {
                position: {
                    lat: state.lat ?? this._map.transform.getCameraLngLat().lat,
                    lng: state.lng ?? this._map.transform.getCameraLngLat().lng,
                    altitude: state.elevation ?? this._map.transform.getCameraAltitude()
                },
                attitude: {
                    heading: state.flightHeading ?? 0,
                    pitch: state.pitchAttitude ?? 0,
                    roll: state.rollAttitude ?? 0
                },
                velocity: {
                    groundSpeed: state.groundSpeed ?? 0,
                    verticalSpeed: state.verticalSpeed ?? 0
                }
            };
            return;
        }

        // Create target state from current state and new values
        const targetState: MotionState = {
            position: {
                lat: state.lat ?? this._currentState.position.lat,
                lng: state.lng ?? this._currentState.position.lng,
                altitude: state.elevation ?? this._currentState.position.altitude
            },
            attitude: {
                heading: state.flightHeading ?? this._currentState.attitude.heading,
                pitch: state.pitchAttitude ?? this._currentState.attitude.pitch,
                roll: state.rollAttitude ?? this._currentState.attitude.roll
            },
            velocity: {
                groundSpeed: state.groundSpeed ?? this._currentState.velocity.groundSpeed,
                verticalSpeed: state.verticalSpeed ?? this._currentState.velocity.verticalSpeed
            }
        };

        // Calculate total frames for interpolation
        const frames = Math.round((deltaTime / 1000) * this.FRAMES);

        // Pre-calculate deltas per frame
        const deltas = {
            lat: (targetState.position.lat - this._currentState.position.lat) / frames,
            lng: this._calculateShortestLongitudeDelta(
                this._currentState.position.lng,
                targetState.position.lng
            ) / frames,
            altitude: (targetState.position.altitude - this._currentState.position.altitude) / frames,
            heading: this._calculateShortestAngleDelta(
                this._currentState.attitude.heading,
                targetState.attitude.heading
            ) / frames,
            pitch: (targetState.attitude.pitch - this._currentState.attitude.pitch) / frames,
            roll: this._calculateShortestAngleDelta(
                this._currentState.attitude.roll,
                targetState.attitude.roll
            ) / frames,
            groundSpeed: (targetState.velocity.groundSpeed - this._currentState.velocity.groundSpeed) / frames,
            verticalSpeed: (targetState.velocity.verticalSpeed - this._currentState.velocity.verticalSpeed) / frames
        };

        // Set up new interpolation
        this._currentInterpolation = {
            start: this._currentState,
            target: targetState,
            remainingFrames: frames,
            deltas
        };

        if (this.shouldPredict) {
            this._updateMotionDerivatives(deltaTime / 1000);
        }
    }

    _updateMotionDerivatives(deltaTime: number) {
        if (!this._previousState || !this._currentState) return;

        const prev = this._previousState;
        const curr = this._currentState;

        // According to WGS-84, 0° to 1° of latitude = 110,574.38855780 metres.
        // Might not be correct for all locations but works for this purpose
        const metersPerDegree = 110574.3;

        // Calculate position differences
        const cosLat = Math.cos(curr.position.lat * Math.PI / 180);
        const dx = (curr.position.lng - prev.position.lng) * cosLat * metersPerDegree;
        const dy = (curr.position.lat - prev.position.lat) * metersPerDegree;
        const dz = curr.position.altitude - prev.position.altitude;

        // Calculate instantaneous velocities
        this._velocity.x = dx / deltaTime;
        this._velocity.y = dy / deltaTime;
        this._velocity.z = dz / deltaTime;

        // Calculate angular differences
        const dHeading = this._calculateShortestAngleDelta(prev.attitude.heading, curr.attitude.heading);
        const dPitch = curr.attitude.pitch - prev.attitude.pitch;
        const dRoll = curr.attitude.roll - prev.attitude.roll;

        // Calculate angular velocities
        this._angularVelocity.heading = dHeading / deltaTime;
        this._angularVelocity.pitch = dPitch / deltaTime;
        this._angularVelocity.roll = dRoll / deltaTime;
    }

    private _interpolateFrame(): void {
        if (!this._currentInterpolation || !this._currentState || !this._map) return;

        if (this._currentInterpolation.remainingFrames <= 0) {
            // Set final state and clear interpolation
            this._currentState = this._currentInterpolation.target;
            this._currentInterpolation = null;
        } else {
            // Update current state using pre-calculated deltas
            this._currentState = {
                position: {
                    lat: this._currentState.position.lat + this._currentInterpolation.deltas.lat,
                    lng: this._currentState.position.lng + this._currentInterpolation.deltas.lng,
                    altitude: this._currentState.position.altitude + this._currentInterpolation.deltas.altitude
                },
                attitude: {
                    heading: (this._currentState.attitude.heading + this._currentInterpolation.deltas.heading + 360) % 360,
                    pitch: this._currentState.attitude.pitch + this._currentInterpolation.deltas.pitch,
                    roll: (this._currentState.attitude.roll + this._currentInterpolation.deltas.roll + 360) % 360
                },
                velocity: {
                    groundSpeed: this._currentState.velocity.groundSpeed + this._currentInterpolation.deltas.groundSpeed,
                    verticalSpeed: this._currentState.velocity.verticalSpeed + this._currentInterpolation.deltas.verticalSpeed
                }
            };

            this._currentInterpolation.remainingFrames--;
        }

        this._updateCamera();
    }

    _updateCamera(): void {
        let stateToUse = this._currentState;

        if (this.predict && this._previousState) {
            if(!this._deltaIsCalculated) {
                this._currentDeltaTimeForPrediction = performance.now() - this._lastUpdateTime; 
                this._deltaIsCalculated = true;
            }

            // Get predicted state
            const predictedState = this._predictCurrentState(this._currentDeltaTimeForPrediction);
            stateToUse = predictedState;
        }

        // Calculate camera position based on state
        const cameraPosition = this._calculateCameraPosition(stateToUse);
        if (!cameraPosition) return;

        const { camPos, camAlt, heading, pitch, roll } = cameraPosition;

        // Update the map camera
        const jumpToOptions = this._map.calculateCameraOptionsFromCameraLngLatAltRotation(
            camPos, camAlt, heading, pitch, roll
        );
        this._map.jumpTo(jumpToOptions);

        if(this.predict) {
            this._updateCamera();
        }
    }

    _predictCurrentState(deltaTime: number): MotionState {
        const state = this._currentState;

        const metersPerDegree = 110574.3;

        // Use smoothed velocities to predict new position
        // Calculate position changes
        const latChange = (this._velocity.y * deltaTime) / metersPerDegree;
        const lngChange = (this._velocity.x * deltaTime) /
            (metersPerDegree * Math.cos(state.position.lat * Math.PI / 180));
        const altChange = this._velocity.z * deltaTime;

        // Calculate attitude changes
        const headingChange = this._angularVelocity.heading * deltaTime;
        const pitchChange = this._angularVelocity.pitch * deltaTime;
        const rollChange = this._angularVelocity.roll * deltaTime;

        // Create predicted state
        const predictedState: MotionState = {
            position: {
                lat: state.position.lat + latChange,
                lng: state.position.lng + lngChange,
                altitude: state.position.altitude + altChange
            },
            attitude: {
                heading: (state.attitude.heading + headingChange + 360) % 360,
                pitch: state.attitude.pitch + pitchChange,
                roll: state.attitude.roll + rollChange
            },
            velocity: {
                groundSpeed: state.velocity.groundSpeed,
                verticalSpeed: state.velocity.verticalSpeed,
            },
        };

        return predictedState;
    }

    _calculateShortestAngleDelta(start: number, end: number): number {
        start = ((start % 360) + 360) % 360;
        end = ((end % 360) + 360) % 360;
        let delta = end - start;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    }

    _calculateShortestLongitudeDelta(start: number, end: number): number {
        let delta = end - start;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    }

    /**
     * Calculate relative camera position based on current mode and flight state
     */
    _calculateCameraPosition(state: MotionState = this._currentState): { camPos: LngLat; camAlt: number; heading: number; pitch: number; roll: number } | null {
        if (!this._currentState) return null;

        const mode = this._cameraMode;
        let camPos: LngLat;
        let camAlt: number;
        let heading: number;
        let pitch: number;
        let roll: number;

        // Convert flight pitch to camera pitch:
        // flight pitch 0° → camera pitch 90° (looking ahead)
        // flight pitch 90° → camera pitch 0° (looking down)
        // flight pitch -90° → camera pitch 180° (looking up)
        const convertPitch = (flightPitch: number): number => {
            // Clamp flight pitch to [-90, 90] range
            const clampedPitch = Math.max(-90, Math.min(90, flightPitch));
            // Convert to camera pitch where 90 is straight ahead
            return 90 - clampedPitch;
        };

        switch (mode.type) {
            case 'COCKPIT':
                // Position camera at flight position with slight offset for pilot view
                camPos = new LngLat(state.position.lng, state.position.lat);
                camAlt = state.position.altitude + mode.offset.z;
                heading = state.attitude.heading;
                pitch = convertPitch(state.attitude.pitch);
                roll = state.attitude.roll;
                break;

            case 'CHASE':
                // Calculate chase camera position behind flight
                const offsetMeters = this._calculateChaseOffset(mode.offset);
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

            case 'ORBIT':
                // Calculate orbiting camera position
                const orbitAngle = (performance.now() % 30000) / 30000 * Math.PI * 2;
                const radius = Math.sqrt(mode.offset.y * mode.offset.y + mode.offset.x * mode.offset.x);
                const orbitX = Math.cos(orbitAngle) * radius;
                const orbitY = Math.sin(orbitAngle) * radius;
                camPos = this._offsetPosition(
                    state.position.lat,
                    state.position.lng,
                    0,
                    orbitX,
                    orbitY
                );
                camAlt = state.position.altitude + mode.offset.z;
                heading = this._calculateHeadingToPoint(
                    camPos.lat,
                    camPos.lng,
                    state.position.lat,
                    state.position.lng
                );
                pitch = this._calculatePitchToPoint(
                    camPos.lat,
                    camPos.lng,
                    camAlt,
                    state.position.lat,
                    state.position.lng,
                    state.position.altitude
                );
                roll = 0;
                break;

            case 'FREE':
                camPos = new LngLat(state.position.lng, state.position.lat);
                camAlt = state.position.altitude;
                heading = mode.orientation.heading;
                pitch = mode.orientation.pitch;
                roll = mode.orientation.roll;
                break;
        }

        return { camPos, camAlt, heading, pitch, roll };
    }

    /**
     * Calculate offset position based on bearing and distance
     */
    _offsetPosition(lat: number, lng: number, bearing: number, offsetX: number, offsetY: number): LngLat {

        // Convert to radians and adjust for coord system
        const bearingRad = (bearing - 90) * Math.PI / 180;
        const R = earthRadius;

        const offsetBearing = Math.atan2(offsetY, offsetX);
        const offsetDistance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

        const lat1 = lat * Math.PI / 180;
        const lng1 = lng * Math.PI / 180;
        const bearing1 = bearingRad + offsetBearing;

        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(offsetDistance / R) + Math.cos(lat1) * Math.sin(offsetDistance / R) * Math.cos(bearing1));
        const lng2 = lng1 + Math.atan2(Math.sin(bearing1) * Math.sin(offsetDistance / R) * Math.cos(lat1), Math.cos(offsetDistance / R) - Math.sin(lat1) * Math.sin(lat2));

        return new LngLat(
            lng2 * 180 / Math.PI,
            lat2 * 180 / Math.PI
        );
    }

    /**
     * Calculate chase camera offset based on flight velocity
     */
    _calculateChaseOffset(baseOffset: { x: number; y: number; z: number }) {
        if (!this._currentState) return baseOffset;

        const speed = this._currentState.velocity.groundSpeed;
        const speedFactor = Math.min(speed / 100, 1); // Normalize speed effect

        return {
            x: baseOffset.x,
            y: baseOffset.y * (1 + speedFactor * 0.5), // Increase distance with speed
            z: baseOffset.z * (1 + speedFactor * 0.3)  // Increase height with speed
        };
    }

    /**
     * Calculate heading to look at a point
     */
    _calculateHeadingToPoint(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
        const dLng = (toLng - fromLng) * Math.PI / 180;
        const fromLatRad = fromLat * Math.PI / 180;
        const toLatRad = toLat * Math.PI / 180;

        const y = Math.sin(dLng) * Math.cos(toLatRad);
        const x = Math.cos(fromLatRad) * Math.sin(toLatRad) -
            Math.sin(fromLatRad) * Math.cos(toLatRad) * Math.cos(dLng);

        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    /**
     * Calculate pitch to look at a point
     */
    _calculatePitchToPoint(fromLat: number, fromLng: number, fromAlt: number,
        toLat: number, toLng: number, toAlt: number): number {
        const R = earthRadius;
        const dLat = (toLat - fromLat) * Math.PI / 180;
        const dLng = (toLng - fromLng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;
        const dAlt = toAlt - fromAlt;

        return -Math.atan2(dAlt, distance) * 180 / Math.PI;
    }

    /**
     * Sets the camera mode
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

    startPrediction(): void {
        this.predict = true;
    }

    stopPrediction(): void {
        this.predict = false;
        this._deltaIsCalculated = false;
    }

    getState(): MotionState | null {
        return this._currentState ? { ...this._currentState } : null;
    }
}
