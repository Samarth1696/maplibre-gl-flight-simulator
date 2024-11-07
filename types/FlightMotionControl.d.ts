import { type IControl, type Map, LngLat } from 'maplibre-gl';
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
export declare class FlightMotionControl implements IControl {
    now: any;
    _map: Map;
    _container: HTMLElement;
    _currentState: MotionState | null;
    _previousState: MotionState | null;
    _frameId: number | null;
    _cameraMode: CameraMode;
    _velocitySmoothed: {
        x: number;
        y: number;
        z: number;
    };
    _angularVelocitySmoothed: {
        heading: number;
        pitch: number;
        roll: number;
    };
    constructor(options?: {
        initialPosition?: {
            lat: number;
            lng: number;
            altitude: number;
        };
        cameraMode?: CameraMode;
    });
    onAdd(map: Map): HTMLElement;
    onRemove(): void;
    _startUpdate(): void;
    _stopUpdate(): void;
    updateFlightState(state: {
        lat?: number;
        lng?: number;
        elevation?: number;
        flightHeading?: number;
        groundSpeed?: number;
        verticalSpeed?: number;
        pitchAttitude?: number;
        rollAttitude?: number;
    }): void;
    _updateCameraFromState(): void;
    _predictCurrentState(deltaTime: number): MotionState;
    /**
     * Calculate relative camera position based on current mode and flight state
     */
    _calculateCameraPosition(state?: MotionState): {
        camPos: LngLat;
        camAlt: number;
        heading: number;
        pitch: number;
        roll: number;
    } | null;
    /**
     * Calculate offset position based on bearing and distance
     */
    _offsetPosition(lat: number, lng: number, bearing: number, offsetX: number, offsetY: number): LngLat;
    _updateMotionDerivatives(deltaTime: number): void;
    /**
     * Calculate chase camera offset based on flight velocity
     */
    _calculateChaseOffset(baseOffset: {
        x: number;
        y: number;
        z: number;
    }): {
        x: number;
        y: number;
        z: number;
    };
    /**
     * Calculate heading to look at a point
     */
    _calculateHeadingToPoint(fromLat: number, fromLng: number, toLat: number, toLng: number): number;
    /**
     * Calculate pitch to look at a point
     */
    _calculatePitchToPoint(fromLat: number, fromLng: number, fromAlt: number, toLat: number, toLng: number, toAlt: number): number;
    /**
     * Calculate shortest angle difference
     */
    _shortestAngleDifference(angle1: number, angle2: number): number;
    /**
     * Sets the camera mode
     */
    setCameraMode(mode: CameraMode): void;
    getState(): MotionState | null;
}
export {};
