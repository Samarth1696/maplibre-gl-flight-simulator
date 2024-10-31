const path = require('path');

/** @type {import('webpack').Configuration} */
const umdConfig = {
    entry: './src/index.ts',
    output: {
        filename: 'maplibre-gl-flight-simulator.umd.js',
        path: path.resolve(__dirname, 'dist'),
        library: {
            name: 'maplibre-gl-flight-simulator',
            type: 'umd',
        },
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
            root: 'maplibregl',
        },
    },
    mode: 'production',
};

/** @type {import('webpack').Configuration} */
const esmConfig = {
    entry: './src/index.ts',
    output: {
        filename: 'maplibre-gl-flight-simulator.esm.js',
        path: path.resolve(__dirname, 'dist'),
        library: {
            type: 'module',
        },
        module: true,
    },
    experiments: {
        outputModule: true,
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
        'maplibre-gl': 'maplibre-gl',
    },
    mode: 'production',
};

module.exports = [umdConfig, esmConfig];

