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
export declare class FlightMotionControl implements IControl {
    _map: Map;
    _container: HTMLElement;
    _updateInterval: number | null;
    _currentState: MotionState | null;
    _previousState: MotionState | null;
    _currentInterpolation: MovementInterpolation | null;
    _lastUpdateTime: number;
    _disposed: boolean;
    predict: boolean;
    shouldPredict: boolean;
    _deltaIsCalculated: boolean;
    _currentDeltaTimeForPrediction: number;
    private readonly FRAMES;
    private FRAME_INTERVAL;
    _velocity: {
        x: number;
        y: number;
        z: number;
    };
    _angularVelocity: {
        heading: number;
        pitch: number;
        roll: number;
    };
    _cameraMode: CameraMode;
    private readonly _boundUpdateFrame;
    constructor(options?: {
        initialPosition?: {
            lat: number;
            lng: number;
            altitude: number;
        };
        cameraMode?: CameraMode;
        predict?: boolean;
    });
    onAdd(map: Map): HTMLElement;
    onRemove(): void;
    _dispose(): void;
    _startUpdate(): void;
    _stopUpdate(): void;
    _updateFrame(): void;
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
    _updateMotionDerivatives(deltaTime: number): void;
    private _interpolateFrame;
    _updateCamera(): void;
    _predictCurrentState(deltaTime: number): MotionState;
    _calculateShortestAngleDelta(start: number, end: number): number;
    _calculateShortestLongitudeDelta(start: number, end: number): number;
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
     * Sets the camera mode
     */
    setCameraMode(mode: CameraMode): void;
    startPrediction(): void;
    stopPrediction(): void;
    getState(): MotionState | null;
}
export {};
