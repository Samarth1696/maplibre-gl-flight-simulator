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
    private readonly FRAME_INTERVAL;
    _currentState: MotionState | null;
    _previousState: MotionState | null;
    _interpolationState: MotionState | null;
    _currentInterpolation: MovementInterpolation | null;
    _lastUpdateTime: number;
    private _lastFrameTime;
    private _lastDerivativeCalcTime;
    _disposed: boolean;
    predict: boolean;
    shouldPredict: boolean;
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
    private readonly FRAMES;
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
    /**
     * Main update loop, called after every 16ms.
     * We compute a per-frame deltaTime, then either predict or interpolate.
     */
    _updateFrame(): void;
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
    }): void;
    /**
     * Derive _velocity + _angularVelocity from changes in the flight state.
     * Called after the server updates flight state, so we have a local estimate for prediction.
     */
    _updateMotionDerivatives(deltaTime: number): void;
    /**
     * Predictive movement: apply _velocity (m/s) and _angularVelocity (deg/s) to the current flight state.
     */
    private _predictMovement;
    /**
     * If not predicting, we interpolate across a fixed number of frames toward the latest flight state.
     */
    private _interpolateFrame;
    /**
     * Updates the map camera from whichever state is active:
     *  - If predicting, we use _currentState
     *  - If interpolating, we use _interpolationState
     */
    _updateCamera(): void;
    /**
     * Calculate how to position the camera based on the current mode (cockpit, chase, orbit, free).
     */
    _calculateCameraPosition(state: MotionState): {
        camPos: LngLat;
        camAlt: number;
        heading: number;
        pitch: number;
        roll: number;
    } | null;
    /**
     * Offsets the lat/lng by offsetX/Y meters, factoring in bearing.
     */
    _offsetPosition(lat: number, lng: number, bearing: number, offsetX: number, offsetY: number): LngLat;
    /**
     * Calculate chase camera offset based on flight speed.
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
    _calculateHeadingToPoint(fromLat: number, fromLng: number, toLat: number, toLng: number): number;
    _calculatePitchToPoint(fromLat: number, fromLng: number, fromAlt: number, toLat: number, toLng: number, toAlt: number): number;
    /**
     * Utility: shortest angle delta in [ -180, 180 ]
     */
    _calculateShortestAngleDelta(start: number, end: number): number;
    /**
     * Utility: shortest longitude delta in [ -180, 180 ]
     */
    _calculateShortestLongitudeDelta(start: number, end: number): number;
    /**
     * Set camera mode (COCKPIT, CHASE, ORBIT, FREE)
     */
    setCameraMode(mode: CameraMode): void;
    /**
     * Turn on prediction. Each frame, we apply _velocity + _angularVelocity to the flight.
     */
    startPrediction(): void;
    /**
     * Turn off prediction. Each frame, we go back to interpolation (if new states arrive) or remain static.
     */
    stopPrediction(): void;
    /**
     * Get the current flight state for debugging or external logic.
     */
    getState(): MotionState | null;
}
export {};
