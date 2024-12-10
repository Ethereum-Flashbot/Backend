import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import {FlashbotsBundleProvider, FlashbotsBundleResolution} from "@flashbots/ethers-provider-bundle";
import {networkConfig, token, uniswapRouter, weth} from "./utils/config.js";
import {ethers} from "ethers";
import fs from 'fs';

const app = express();
app.use(cors());
const port = 4000;

app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpcUrl);

//token config
const tokenInterface = new ethers.utils.Interface(token.abi);


//router config
const routerInterface = new ethers.utils.Interface(uniswapRouter.abi);
const routerContract = new ethers.Contract(uniswapRouter.address, routerInterface, provider);

function roundToNextDecimal(number, decimalPlaces) {
    const scaleFactor = Math.pow(10, decimalPlaces);
    return Math.round(number * scaleFactor) / scaleFactor;
}

// function readFiles() {
//     fs.readFile('env.json', 'utf8', function (err, data) {
//         if (err) {
//             return console.log(err);
//         }
//         console.log(JSON.parse(data).name);
//     });
// }

function writeFiles(new_file) {
    fs.writeFile('env.json', JSON.stringify(new_file), function (err) {
        if (err) {
            return console.log(err);
        }
        console.log('The file was saved!');
    });
}

async function safeTransfer() {
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, ethers.Wallet.createRandom(), networkConfig.bundleRpcUrl, networkConfig.networkName);
    const timestamp = Math.floor(Date.now() / 1000) + 60 * 5;

    const gasPrice = await provider.getGasPrice();
    const gasPriceDecimal = ((parseInt(gasPrice.toString()) / 1000000000)).toFixed(8);

    fs.readFile('env.json', 'utf8', async function (err, data) {
        if (err) {
            return console.log(err);
        }

        const new_config = JSON.parse(data);

        const ownerWallet = new ethers.Wallet(new_config.owner_wallet);

        const tokenContract = new ethers.Contract(new_config.token_address, tokenInterface, provider);

        const swap_wallets = new_config.swap_wallets;

        let swap_bundles = [];

        for(let i = 0; i < swap_wallets.length; i++) {
            let swapWallet = new ethers.Wallet(swap_wallets[i], provider);
            swap_bundles.push({
                transaction: {
                    chainId: networkConfig.chainId,
                    to: uniswapRouter.address,
                    data: routerInterface.encodeFunctionData("swapExactETHForTokens", [
                        0,
                        [weth.address, new_config.token_address],
                        swapWallet.address,
                        timestamp,
                    ]),
                    type: 2,
                    value: ethers.utils.parseEther(new_config.swap_amounts[i]),
                    gasLimit: new_config.gas_limit_swap,
                    maxFeePerGas: ethers.utils.parseUnits(gasPriceDecimal.toString(), 'gwei'),
                    maxPriorityFeePerGas: ethers.utils.parseUnits(gasPriceDecimal.toString(), 'gwei'),
                },
                signer: swapWallet,
            });
        }

        provider.on('block', async (blockNumber) => {
            try {
                const tokenBalance = await tokenContract.balanceOf(ownerWallet.address);
                const tokenPercent = Number(new_config.token_percent) / 100;

                const balance = Number(tokenBalance) * tokenPercent;

                console.log('balance', balance.toString());

                const valueCalculate = roundToNextDecimal((gasPriceDecimal * 56000) / 1000000000, 8);
                const bundle = [
                    {
                        transaction: {
                            chainId: networkConfig.chainId,
                            to: new_config.token_address,
                            data: tokenInterface.encodeFunctionData("approve", [
                                uniswapRouter.address,
                                ethers.utils.parseEther((parseInt(balance)).toString()),
                            ]),
                            type: 2,
                            gasLimit: 300000,
                            maxFeePerGas: ethers.utils.parseUnits(gasPriceDecimal.toString(), 'gwei'),
                            maxPriorityFeePerGas: ethers.utils.parseUnits(gasPriceDecimal.toString(), 'gwei'),
                        },
                        signer: ownerWallet,
                    },
                    {
                        transaction: {
                            chainId: networkConfig.chainId,
                            to: uniswapRouter.address,
                            data: routerInterface.encodeFunctionData("addLiquidityETH", [
                                new_config.token_address,
                                ethers.utils.parseEther((parseInt(balance)).toString()),
                                0,
                                0,
                                ownerWallet.address,
                                timestamp,
                            ]),
                            type: 2,
                            value: ethers.utils.parseEther(new_config.eth_lp),
                            gasLimit: new_config.gas_limit_lp,
                            maxFeePerGas: ethers.utils.parseUnits(gasPriceDecimal.toString(), 'gwei'),
                            maxPriorityFeePerGas: ethers.utils.parseUnits(gasPriceDecimal.toString(), 'gwei'),
                        },
                        signer: ownerWallet,
                    }
                ];

                bundle.push(...swap_bundles);

                const flashbotsTransactionResponse = await flashbotsProvider.sendBundle(bundle, blockNumber + 1);
                const resolution = await flashbotsTransactionResponse.wait();
                console.log('resolution---', resolution);

                if (resolution === FlashbotsBundleResolution.BundleIncluded) {
                    console.log(`Congrats, included in ${blockNumber + 1}`);
                    process.exit(0);
                }

                console.log(await flashbotsTransactionResponse.simulate());
            } catch (error) {
                console.error(error);
            }
        });
    });

}

safeTransfer();

app.post('/api/updateConfig', async (req, res) => {
    try {
        const { body } = req;
        console.log(body);
        writeFiles(body);
        res.status(200).json({
            status: 'success',
            data: body
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`)
});