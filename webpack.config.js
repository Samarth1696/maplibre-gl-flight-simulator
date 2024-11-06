const path = require('path');

/** @type {import('webpack').Configuration} */
const umdConfig = {
    entry: './src/index.ts',
    output: {
        filename: 'maplibre-gl-flight-simulator.js',
        path: path.resolve(__dirname, 'dist'),
        library: 'MaplibreGlFlightSimulator',
        libraryTarget: 'umd',
        globalObject: 'this',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader',
            },
        ],
    },
    externals: {
        'maplibre-gl': {
            commonjs: 'maplibre-gl',
            commonjs2: 'maplibre-gl',
            amd: 'maplibre-gl',
            root: 'maplibregl'
        }
    },
    mode: 'production',
};

/** @type {import('webpack').Configuration} */
const devConfig = {
    devtool: 'eval-source-map',
    entry: './src/index.ts',
    output: {
        filename: 'maplibre-gl-flight-simulator-dev.js',
        path: path.resolve(__dirname, 'dist'),
        library: 'MaplibreGlFlightSimulator',
        libraryTarget: 'umd',
        globalObject: 'this',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader',
            },
        ],
    },
    externals: {
        'maplibre-gl': {
            commonjs: 'maplibre-gl',
            commonjs2: 'maplibre-gl',
            amd: 'maplibre-gl',
            root: 'maplibregl'
        }
    },
    mode: 'development',
};

module.exports = [umdConfig, devConfig];

