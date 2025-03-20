import { PORT, MongoDB_URL } from './config.js'
import axios from 'axios'
import axiosRetry from 'axios-retry'
import cheerio from 'cheerio'
import { MongoClient } from 'mongodb'
import express from 'express'
const app = express()
import cors from 'cors'

app.use(cors())

axiosRetry(axios, {
    retries: 3,
    retryDelay: (retryCount) => {
        console.log(`retry attempt: ${retryCount}`);
        return retryCount * 10000;
    },
    retryCondition: (error) => error.response && error.response.status === 503,
});

const baseUrl = 'https://mzamin.com/news.php?news='
let startNumber = 1
let additionalNumber = 0
const retry_delay = 1800000
let emptyNewsNum = 0

const client = new MongoClient(MongoDB_URL)

const connectDB = async () => {
    try {
        await client.connect()
        console.log('Database connected successfully.')

        const database = client.db('bangla-text-database')
        const collection = database.collection('mzamin-news-collection')

        // Get the last collected news
        const lastNews = await collection.find().sort({ collectedAt: -1 }).limit(1).toArray()

        if (lastNews.length > 0) {
            startNumber = lastNews[0].newsSlNum + 1 // Start from the next news
        }

        scrapeAndInsert(collection)

    } catch (err) {
        console.error('Error connecting to the database:', err)
    }
}

connectDB()

async function scrapeAndInsert(collection) {
    try {
        while (emptyNewsNum <= 500) {
            const url = `${baseUrl}${startNumber}`
            const response = await axios(url)
            const html = response.data
            const $ = cheerio.load(html)

            let title = $('.container article .lh-base.fs-1', html).text()
            let publishedDate = $('.container header .row.d-flex.justify-content-center.py-3 p.text-center', html).text()
            let news = $('.container article .row.gx-5.mt-5 .col-sm-8 .col-sm-10.offset-sm-1.fs-5.lh-base.mt-4.mb-5 p', html)
                .map(function () {
                    return $(this).text()
                })
                .get();

            if (news.length === 0) {
                emptyNewsNum++
                console.log(`news no. ${startNumber} not found at ${new Date()}.`)

                if (additionalNumber < 100) {
                    additionalNumber++
                    startNumber++
                    console.log('Additional number counted')
                } else {
                    additionalNumber = 0
                    console.log(`Waiting for ${retry_delay / 1000} seconds...`)
                    await new Promise(resolve => setTimeout(resolve, retry_delay))
                }
            } else {
                emptyNewsNum = 0

                const resultDocument = {
                    newsSlNum: startNumber,
                    collectedAt: Date.now(),
                    url,
                    title,
                    publishedDate,
                    news,
                }

                await collection.insertOne(resultDocument)

                process.stdout.write(`\rNews no. ${startNumber} scrapped at ${new Date()}         `)

                startNumber++
            }
        }

        console.log(`\nScraping complete at ${new Date()}`)
        await client.close()

    } catch (err) {
        console.error(err)
    }
}

app.get('/results', (req, res) => {
    res.json({ message: 'Scraping in progress. Check console logs for updates.' })
})

app.listen(PORT, () => console.log(`Server running on PORT ${PORT}`))
