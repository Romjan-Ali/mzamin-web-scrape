import dotenv from 'dotenv'
import axios from 'axios';
import axiosRetry from 'axios-retry';
import cheerio from 'cheerio';
import { MongoClient } from 'mongodb';
import express from 'express';
const app = express();
import cors from 'cors';

dotenv.config()

app.use(cors());

app.get('/', (req, res) => {
    res.send('Scraper is running and alive!');
});

axiosRetry(axios, {
    retries: 3,
    retryDelay: (retryCount) => {
        console.log(`Retry attempt: ${retryCount}`);
        return retryCount * 10000;
    },
    retryCondition: (error) =>
        error.response && [503, 429].includes(error.response.status) ||
        error.code === 'ECONNABORTED',
});

const baseUrl = 'https://mzamin.com/news.php?news=';
let startNumber = 1;
const retryDelay = 1800000;
let emptyNewsNum = 0;
const concurrencyLimit = 100; // Number of concurrent tasks
let time = Date.now();

let interval;
let seconds = 0;

const client = new MongoClient(process.env.MongoDB_URL);

const connectDB = async () => {
    try {
        if (interval) {
            clearInterval(interval)
        }
        seconds = 0

        await client.connect();
        console.log('Database connected successfully.');

        const database = client.db('bangla-text-database');
        const collection = database.collection('mzamin-news-collection');

        // Get the last collected news
        const lastNews = await collection.find().sort({ collectedAt: -1 }).limit(1).toArray();
        if (lastNews.length > 0) {
            startNumber = lastNews[0].newsSlNum + 1;
        }

        scrapeAndInsert(collection);
    } catch (err) {
        console.error('Error connecting to the database:', err);
    }
};

connectDB();

async function fetchNews(newsNumber) {
    try {
        if (interval) {
            clearInterval(interval)
        }

        const url = `${baseUrl}${newsNumber}`;
        const startTime = Date.now(); // Track response time

        const response = await axios(url);
        const elapsedTime = Date.now() - startTime; // Calculate response time

        if (elapsedTime > 20000) {
            console.error(`Slow response detected (${elapsedTime}ms). Retrying...`);
            return null; // Return null instead of exiting the process
        }

        const html = response.data;
        const $ = cheerio.load(html);

        let title = $('.container article .lh-base.fs-1', html).text();
        let publishedDate = $('.container header .row.d-flex.justify-content-center.py-3 p.text-center', html).text();
        let news = $('.container article .row.gx-5.mt-5 .col-sm-8 .col-sm-10.offset-sm-1.fs-5.lh-base.mt-4.mb-5 p', html)
            .map(function () {
                return $(this).text();
            })
            .get();

        if (news.length === 0) {
            process.stdout.write(`\nNews no. ${newsNumber} not found.`);
            return null;
        }

        console.log(`${newsNumber}`)

        return {
            newsSlNum: newsNumber,
            collectedAt: Date.now(),
            url,
            title,
            publishedDate,
            news,
        };
    } catch (err) {
        console.error(`Error fetching news ${newsNumber}:`, err);
        return null;
    }
}

async function scrapeAndInsert(collection) {
    try {
        while (emptyNewsNum <= 500) {
            // Clear any existing interval at the start of each loop
            if (interval) {
                clearInterval(interval);
            }

            const newsNumbers = Array.from({ length: concurrencyLimit }, (_, i) => startNumber + i);

            const newsResults = await Promise.all(newsNumbers.map(fetchNews));
            const validResults = newsResults.filter((news) => news !== null);

            if (validResults.length === 0) {
                emptyNewsNum++;
                console.log(`No news found for the current batch. Attempt: ${emptyNewsNum}`);

                // If we have encountered several empty results, wait before retrying
                if (emptyNewsNum >= 5) {
                    console.log(`Pausing for ${retryDelay / 1000} seconds due to consecutive empty results.`);
                    await new Promise((resolve) => setTimeout(resolve, retryDelay)); // Wait for retryDelay time
                    emptyNewsNum = 0; // Reset empty counter after retry delay
                    seconds = 0; // Reset seconds on retry
                }
                // Do not increment startNumber, retry with the same batch of news numbers
                continue;
            } else {
                emptyNewsNum = 0; // Reset empty counter after successful batch
                await collection.insertMany(validResults);
                process.stdout.write(`\nInserted ${validResults.length} news articles.`);
                process.stdout.write(`\nLast scraped news no: ${startNumber}`);
                console.log('Scraped at', new Date())
                process.stdout.write(`\nTime needed ${Date.now() - time} milliseconds\n`);
                console.log('------------------------------------------------')
                time = Date.now();

                // After a successful batch, increment startNumber for the next iteration
                startNumber += concurrencyLimit;
                seconds = 0; // Reset seconds after a successful batch
            }

            // Start interval after processing each batch
            interval = setInterval(() => {
                seconds++;
                if (seconds > 25) {
                    seconds = 0; // Reset seconds if they exceed 25
                    console.log('25 seconds passed, attempting to reconnect to the database...');
                    connectDB(); // Attempt to reconnect to the database
                }
            }, 1000); // Run every second
        }

        console.log(`\nScraping complete at ${new Date()}`);
        await client.close();
    } catch (err) {
        console.error(err);
    }
}

process.on('SIGINT', async () => {
    await client.close();
    console.log('Database connection closed.');
    process.exit(0);
});

app.get('/results', (req, res) => {
    res.json({ message: 'Scraping in progress. Check console logs for updates.' });
});

app.listen(process.env.PORT, () => console.log(`Server running on PORT ${process.env.PORT}`));
