var crypto = require('crypto');
var https = require('https');

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

var travis = {

    // Travis CI set environment variables
    // https://docs.travis-ci.com/user/ci-environment/#Environment-variables
    CURRENT_JOB_ID: parseInt(process.env.TRAVIS_JOB_ID, 10),
    CURRENT_JOB_TEST_RESULT: parseInt(process.env.TRAVIS_TEST_RESULT, 10),

    // Travis CI API URLs
    // https://docs.travis-ci.com/api/
    API_BUILD_URL: 'https://api.travis-ci.org/builds/' + parseInt(process.env.TRAVIS_BUILD_ID, 10),
    API_JOBS_URL: 'https://api.travis-ci.org/jobs/'

};

var configs = {

    callback: undefined,

    // max wait time between checking other job status, in milliseconds
    CHECK_INTERVAL_LIMIT: 15000,
    // milliseconds to wait before checking other job status again
    checkInterval: 3000,

    keys: {
        'FAILURE': 'travis-after-all: failed',
        'SUCCESS': 'travis-after-all: succeeded'
    },

    LOG_PREFIX: '[travis-after-all]'

};

// ---------------------------------------------------------------------

function allJobsAreFinished(jobs) {
    return jobs.every(jobFinished);
}

// Exit the current job, with exit status given by `code':
//  * 0 for the leader job, if the build succeeded
//  * 1 for the leader job, if the build succeeded
//  * 2 for non-leader jobs
//  * 3 if something went wrong (e.g. network failure)
function endJob(code, error) {

    if ( error !== undefined ) {
        log(error.message);
    }

    if ( code === 2 ) {
        log('Some other job was assigned to do the task');
    }

    if ( typeof configs.callback === 'function' ) {
        configs.callback(code, error);
    } else {
        log('I am the leader, and the result is ' + code);
        process.exit(code);
    }

}

function generateToken(text, key) {
    return crypto.createHmac('sha256', key).update('' + text).digest('hex');
}

// Get the list of jobs for this build and start checking for their results.
function getBuildData() {
     getJSON(travis.API_BUILD_URL, function (data) {

         var jobs = data.matrix;

         // Set the result of the current job, to avoid the
         // need for a Travis API call for that job.

         jobs.some(function (job) {
             if ( job.id === travis.CURRENT_JOB_ID ) {
                 job.result = travis.CURRENT_JOB_TEST_RESULT;
                 return true;
             }
             return false;
         });

         handleJob(jobs);

     });
}

// Get JSON data from url, and call callback on it.
function getJSON(url, callback) {

    https.get(url, function(response) {

        var body = '';

        response.setEncoding('utf8');

        response.on('data', function (chunk) {
            body += chunk;
        });

        response.on('end', function () {

            var parsed;
            try {
                parsed = JSON.parse(body);
            } catch (error) {
                error.message = 'Failed to parse JSON from "' + url +'".\nError: ' + error.message;
                endJob(3, error);
            }
            try {
                callback(parsed);
            } catch (error) {
                endJob(3, error);
            }
        });

    }).on('error', function (error) {
        endJob(3, error);
    });

}

// Return the job with the given id, from the list jobs
function getJob(jobs, id) {

    var result;

    jobs.some(function (job) {
        if ( job.id === id ) {
            result = job;
            return true;
        }
        return false;
    });

    return result;

}

// This function is hard to understand.  Maybe it means that job data is available for all the jobs up to indexedJobList.index, and each invocation fills in the result for one more job?

// This gets job data via the Travis API, then handles the job.
// Argument indexedJobList is a struct containing two fields:
// index (an int) and jobs (a list).
function getJobData(indexedJobList) {

    var currentJob;
    // var unfinishedJobs;

    if ( indexedJobList.index < indexedJobList.jobs.length ) {

        currentJob = indexedJobList.jobs[indexedJobList.index];
        indexedJobList.index++;

        if ( currentJob.id === travis.CURRENT_JOB_ID ||
             (currentJob.finished_at !== null && currentJob.result !== null) ) {

            getJobData(indexedJobList);

        } else {

            getJSON(travis.API_JOBS_URL + currentJob.id, function (data) {

                var jobLog = data.log;

                // If written, get the result of the job from
                // the special token written within its log.

                if ( jobLog.indexOf(generateToken(currentJob.id, configs.keys.SUCCESS)) !== -1 ) {
                    currentJob.result = 0;
                } else if ( jobLog.indexOf(generateToken(currentJob.id, configs.keys.FAILURE)) !== -1 ) {
                    currentJob.result = 1;
                }

                currentJob.finished_at = data.finished_at;

                getJobData(indexedJobList);

            });

        }

    } else {
        handleJob(indexedJobList.jobs);
    }

}

function getJobNumbersOfUnfinishedJobs(jobs) {
    var unfinishedJobs = [];
    jobs.forEach(function (job) {
        if ( jobFinished(job) ) {
            unfinishedJobs.push(job.number);
        }
    });
    return unfinishedJobs;
}

function log(msg) {
    console.log('%s %s', configs.LOG_PREFIX, msg);
}

// Write the result of current job in its log if it isn't written already.
function logJobResult(job) {

    // Create a special token based on the result of the job (this
    // is done so that the chance of that text existing in the log
    // is minimal / non-existent).
    var msg = '';
    var token;
    if ( travis.CURRENT_JOB_TEST_RESULT === 0 ) {
        token = generateToken(travis.CURRENT_JOB_ID, configs.keys.SUCCESS);
        msg += 'Job succeeded (' + token + ')';
    } else {
        token = generateToken(travis.CURRENT_JOB_ID, configs.keys.FAILURE);
        msg += 'Job failed (' + token + ')';
    }

    // If the token is already present in the log, don't write it again.
    // This is done in order to reduce the output in the case where this
    // script is executed multiple times - e.g.: the user uses multiple
    // scripts that include this script).
    if ( job.log.indexOf(token) === -1 ) {
        log(msg);
    }

}

function jobFinished(job) {
    // Don't test job.state or job.result, which are undefined if the job
    // was canceled.
    return (job.finished_at !== null);
}

function jobFailed(job) {
    return (job.allow_failure === false)
        && (job.result !== 0)
        && jobFinished(job);
}

function thereIsAFailingJob(jobs)  {
    return jobs.some(jobFailed);
}

function jobSucceeded(job) {
    return job.result === 0;
}

function thereIsASuccessfulJob(jobs)  {
    return jobs.some(jobSucceeded);
}

function isLeaderJob(job, jobs) {
    return job === jobs[jobs.length-1];
}

function waitThenGetJobData(jobs) {

    var indexedJobList = {
        index: 0,
        jobs: jobs
    };

    var unfinishedJobs = getJobNumbersOfUnfinishedJobs(indexedJobList.jobs);

    if ( unfinishedJobs.length !== 0 ) {
        log('Waiting for ' + unfinishedJobs.join(', ').replace(/,(?!.*,)/, ' and') + ' to finish...');
    }

    // If the jobs take longer to finish, gradually increase
    // the check interval time up to the specified limit.

    configs.checkInterval = Math.min(configs.checkInterval * 2, configs.CHECK_INTERVAL_LIMIT);

    setTimeout(function () {
        getJobData(indexedJobList);
    }, configs.checkInterval);

}

// ---------------------------------------------------------------------

// Conventions:
//
//  * The last job will be the leader job that is assigned to run the
//    user-defined success or fail tasks.
//    A downside is that this might be a job that was allowed to fail.
//    If your after-success script must run on a job that has succeeded,
//    then you should order your jobs so the last one is not one that is
//    allowed to fail.

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function handleJob(jobs) {

    var currentJob = getJob(jobs, travis.CURRENT_JOB_ID);

    if ( ! isLeaderJob(currentJob, jobs) )  {
        endJob(2);
    }

    // Mark the current job as finished
    currentJob.finished_at = "now";

    // If some job failed (that is not allowed to fail), the build failed.
    if ( thereIsAFailingJob(jobs) ) {
        endJob(1);
    }

    if ( allJobsAreFinished(jobs) ) {
        // If there is a successful job, the build succeeded.
        if ( thereIsASuccessfulJob(jobs) ) {
            endJob(0);
        } else {
            // Otherwise, there are only jobs that were allowed
            // to fail and all of them fail, therefore, the build
            // failed, so assign the current job to run the user
            // defined fail tasks.
            endJob(1);
        }
    }

    // No job has failed yet, and some job has not finished.
    // So, we need to wait a bit, check the status of the
    // other jobs, and try again.
    waitThenGetJobData(jobs);
}



// ---------------------------------------------------------------------

function main(callback) {

    configs.callback = callback;

    getJSON(travis.API_JOBS_URL + travis.CURRENT_JOB_ID, function (data) {

        // Write the result of current job in its log if it isn't
        // written already (this needs to be done because there isn't
        // any other way for the other jobs to know the result of the
        // current job without it actually be finished).

        logJobResult(data);

        // Get the list of jobs for this build and start checking for
        // their results.

        getBuildData();

    });

}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// Based on how this script is called,
// invoke `main` differentlly.

// 1) If this script is called directly:

if ( require.main === module ||
     module.parent === undefined ) {

    main();

// 2) If it's required as a module:

} else {
    module.exports = main;
}
