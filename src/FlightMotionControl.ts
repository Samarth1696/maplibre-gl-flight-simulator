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
    lastUpdateTime: number;
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

export class FlightMotionControl implements IControl {

    now = (typeof performance !== 'undefined' && performance.now) ? performance.now.bind(performance) : Date.now;

    _map: Map;
    _container: HTMLElement;
    _currentState: MotionState | null = null;
    _previousState: MotionState | null = null;
    _frameId: number | null = null;

    // Camera configuration
    _cameraMode: CameraMode = {
        type: 'COCKPIT',
        offset: { x: 0, y: -30, z: 10 },
        orientation: { heading: 0, pitch: 0, roll: 0 }
    };

    // Interpolation state
    _velocitySmoothed = { x: 0, y: 0, z: 0 };
    _angularVelocitySmoothed = { heading: 0, pitch: 0, roll: 0 };

    constructor(options: {
        initialPosition?: {
            lat: number;
            lng: number;
            altitude: number;
        };
        cameraMode?: CameraMode;
    } = {}) {
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
                    verticalSpeed: 0,
                },
                lastUpdateTime: this.now()
            };
        }

        if (options.cameraMode) {
            this._cameraMode = {
                ...options.cameraMode,
                offset: options.cameraMode.offset || { x: 0, y: 0, z: 0 },
                orientation: options.cameraMode.orientation || { heading: 0, pitch: 0, roll: 0 }
            };
        }
    }

    onAdd(map: Map): HTMLElement {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl';

        this._map.dragRotate.disable();
        this._map.touchZoomRotate.disableRotation();
        this._map.keyboard.disable();

        // Start the update loop
        this._startUpdate();

        return this._container;
    }

    onRemove(): void {
        this._stopUpdate();
        this._container.parentNode?.removeChild(this._container);

        this._map.dragRotate.enable();
        this._map.touchZoomRotate.enableRotation();
        this._map.keyboard.enable();
        this._map = undefined;
    }

    _startUpdate(): void {
        const updateFrame = () => {
            this._updateCameraFromState();
            this._frameId = requestAnimationFrame(updateFrame);
        };
        this._frameId = requestAnimationFrame(updateFrame);
    }

    _stopUpdate(): void {
        if (this._frameId) {
            cancelAnimationFrame(this._frameId);
            this._frameId = null;
        }
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
    }) {
        const now = this.now();
        const deltaTime = this._currentState ?
            (now - this._currentState.lastUpdateTime) / 1000 : 0;

        // Store previous state
        this._previousState = this._currentState;

        // If we don't have a current state, we need minimum values to start
        if (!this._currentState) {
            this._currentState = {
                position: {
                    lat: state.lat || 0,
                    lng: state.lng || 0,
                    altitude: state.elevation || 0
                },
                attitude: {
                    heading: state.flightHeading || 0,
                    pitch: state.pitchAttitude || 0,
                    roll: state.rollAttitude || 0
                },
                velocity: {
                    groundSpeed: state.groundSpeed || 0,
                    verticalSpeed: state.verticalSpeed || 0,
                },
                lastUpdateTime: now
            };
            return;
        }

        // Calculate missing values based on previous state and provided values
        const position = {
            lat: state.lat ?? this._currentState.position.lat,
            lng: state.lng ?? this._currentState.position.lng,
            altitude: state.elevation
        };

        // If elevation is not provided but verticalSpeed is available,
        // calculate new elevation based on vertical speed and time
        if (position.altitude === undefined && state.verticalSpeed !== undefined) {
            const verticalDelta = state.verticalSpeed * deltaTime;
            position.altitude = this._currentState.position.altitude + verticalDelta;
        } else if (position.altitude === undefined) {
            position.altitude = this._currentState.position.altitude;
        }

        // If verticalSpeed is missing but elevation changed, calculate it
        let verticalSpeed = state.verticalSpeed;
        if (verticalSpeed === undefined && state.elevation !== undefined) {
            verticalSpeed = (position.altitude - this._currentState.position.altitude) / deltaTime;
        } else if (verticalSpeed === undefined) {
            verticalSpeed = this._currentState.velocity.verticalSpeed;
        }

        // If groundSpeed is missing but we have position changes, calculate it
        let groundSpeed = state.groundSpeed;
        if (groundSpeed === undefined && (state.lat !== undefined || state.lng !== undefined)) {
            const metersPerDegree = 111111;
            const dx = (position.lng - this._currentState.position.lng) * Math.cos(position.lat * Math.PI / 180) * metersPerDegree;
            const dy = (position.lat - this._currentState.position.lat) * metersPerDegree;
            groundSpeed = Math.sqrt(dx * dx + dy * dy) / deltaTime;
        } else if (groundSpeed === undefined) {
            groundSpeed = this._currentState.velocity.groundSpeed;
        }

        // Calculate or maintain heading values
        let flightHeading = state.flightHeading;
        if (flightHeading === undefined && (state.lat !== undefined || state.lng !== undefined)) {
            // Calculate heading from position change
            const dx = position.lng - this._currentState.position.lng;
            const dy = position.lat - this._currentState.position.lat;
            flightHeading = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
        } else if (flightHeading === undefined) {
            flightHeading = this._currentState.attitude.heading;
        }

        // Calculate or maintain pitch
        let pitchAttitude = state.pitchAttitude;
        if (pitchAttitude === undefined && verticalSpeed !== undefined && groundSpeed !== undefined) {
            // Calculate pitch from vertical and ground speed
            pitchAttitude = Math.atan2(verticalSpeed, groundSpeed) * 180 / Math.PI;
        } else if (pitchAttitude === undefined) {
            pitchAttitude = this._currentState.attitude.pitch;
        }

        // Maintain roll if not provided
        const rollAttitude = state.rollAttitude ?? this._currentState.attitude.roll;

        this._currentState = {
            position: {
                lat: position.lat,
                lng: position.lng,
                altitude: position.altitude
            },
            attitude: {
                heading: flightHeading,
                pitch: pitchAttitude,
                roll: rollAttitude
            },
            velocity: {
                groundSpeed,
                verticalSpeed,
            },
            lastUpdateTime: now
        };

        // Calculate motion derivatives if we have previous state
        if (this._previousState && deltaTime > 0) {
            this._updateMotionDerivatives(deltaTime);
        }
    }

    _updateCameraFromState(): void {
        if (!this._currentState || !this._map) return;

        const now = this.now();
        const deltaTime = (now - this._currentState.lastUpdateTime) / 1000;

        // Predict current position based on last known velocity
        const predictedState = this._predictCurrentState(deltaTime);

        const cameraPosition = this._calculateCameraPosition(predictedState);
        if (!cameraPosition) return;

        const {camPos, camAlt, heading, pitch, roll} = cameraPosition;

        // Update the map camera
        const jumpToOptions = this._map.calculateCameraOptionsFromCameraLngLatAltRotation(camPos, camAlt, heading, pitch, roll);
        this._map.jumpTo(jumpToOptions);
    }

    _predictCurrentState(deltaTime: number): MotionState {
        const state = this._currentState;

        const metersPerDegree = 111111;

        // Use smoothed velocities to predict new position
        // Calculate position changes
        const latChange = (this._velocitySmoothed.y * deltaTime) / metersPerDegree;
        const lngChange = (this._velocitySmoothed.x * deltaTime) /
            (metersPerDegree * Math.cos(state.position.lat * Math.PI / 180));
        const altChange = this._velocitySmoothed.z * deltaTime;

        // Calculate attitude changes
        const headingChange = this._angularVelocitySmoothed.heading * deltaTime;
        const pitchChange = this._angularVelocitySmoothed.pitch * deltaTime;
        const rollChange = this._angularVelocitySmoothed.roll * deltaTime;

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
            lastUpdateTime: state.lastUpdateTime
        };

        return predictedState;
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
                const orbitAngle = (this.now() % 30000) / 30000 * Math.PI * 2;
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

    _updateMotionDerivatives(deltaTime: number) {
        if (!this._previousState || !this._currentState) return;

        const prev = this._previousState;
        const curr = this._currentState;

        const metersPerDegree = 111111;

        // Calculate position differences
        const cosLat = Math.cos(curr.position.lat * Math.PI / 180);
        const dx = (curr.position.lng - prev.position.lng) * cosLat * metersPerDegree;
        const dy = (curr.position.lat - prev.position.lat) * metersPerDegree;
        const dz = curr.position.altitude - prev.position.altitude;

        // Calculate instantaneous velocities
        const vx = dx / deltaTime;
        const vy = dy / deltaTime;
        const vz = dz / deltaTime;

        // Calculate angular differences
        const dHeading = this._shortestAngleDifference(prev.attitude.heading, curr.attitude.heading);
        const dPitch = curr.attitude.pitch - prev.attitude.pitch;
        const dRoll = curr.attitude.roll - prev.attitude.roll;

        // Calculate angular velocities
        const angularVelocityHeading = dHeading / deltaTime;
        const angularVelocityPitch = dPitch / deltaTime;
        const angularVelocityRoll = dRoll / deltaTime;

        // Apply smoothing
        // Increase the smoothing factor to add more precision
        const predictionSmoothingFactor = 0.3;

        // Smooth linear velocities
        this._velocitySmoothed.x = this._velocitySmoothed.x + (vx - this._velocitySmoothed.x) * predictionSmoothingFactor;
        this._velocitySmoothed.y = this._velocitySmoothed.y + (vy - this._velocitySmoothed.y) * predictionSmoothingFactor;
        this._velocitySmoothed.z = this._velocitySmoothed.z + (vz - this._velocitySmoothed.z) * predictionSmoothingFactor;

        // Smooth angular velocities
        this._angularVelocitySmoothed.heading = this._angularVelocitySmoothed.heading + (angularVelocityHeading - this._angularVelocitySmoothed.heading) * predictionSmoothingFactor;
        this._angularVelocitySmoothed.pitch = this._angularVelocitySmoothed.pitch + (angularVelocityPitch - this._angularVelocitySmoothed.pitch) * predictionSmoothingFactor;
        this._angularVelocitySmoothed.roll = this._angularVelocitySmoothed.roll + (angularVelocityRoll - this._angularVelocitySmoothed.roll) * predictionSmoothingFactor;
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
     * Calculate shortest angle difference
     */
    _shortestAngleDifference(angle1: number, angle2: number): number {
        let diff = angle2 - angle1;
        while (diff > 180) diff = diff - 360;
        while (diff < -180) diff = diff + 360;
        return diff;
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

        if (this._currentState) {
            this._updateCameraFromState();
        }
    }

    getState(): MotionState | null {
        return this._currentState ? { ...this._currentState } : null;
    }
}

