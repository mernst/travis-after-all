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
    return jobs.every(function (job) {
        return job.result !== null;
    });
}

// Exit the current job, with exit status given by `code'~
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
            log('getJSON: parsed ' + url);
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

// This function is hard to understand, but maybe it means that job data is available for all the jobs up to indexedJobList.index??

// This gets job data via the Travis API, then handles the job.
// Argument indexedJobList is a struct containing two fields:
// index (an int) and jobs (a list).
function getJobData(indexedJobList) {

    log('getJobData: index=' + indexedJobList.index);

    var currentJob;
    // var unfinishedJobs;

    if ( indexedJobList.index < indexedJobList.jobs.length ) {

        currentJob = indexedJobList.jobs[indexedJobList.index];
        indexedJobList.index++;

        if ( currentJob.id === travis.CURRENT_JOB_ID ||
                currentJob.finished_at !== null && currentJob.result !== null ) {

            getJobData(indexedJobList);

        } else {

            getJSON(travis.API_JOBS_URL + currentJob.id, function (data) {

                log('Received data from ' + travis.API_JOBS_URL + currentJob.id);

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

function getIdsOfJobs(jobs) {
    var result = [];
    jobs.forEach(function (job) {
        result.push(job.id);
    });
    return result;
}

function getStatesOfJobs(jobs) {
    var result = [];
    jobs.forEach(function (job) {
        result.push(job.state);
    });
    return result;
}

function getJobNumbersOfJobs(jobs) {
    var jobNumbers = [];
    jobs.forEach(function (job) {
        jobNumbers.push(job.number);
    });
    return jobNumbers;
}

function getJobNumbersOfUnfinishedJobs(jobs) {

    var unfinishedJobs = [];

    jobs.forEach(function (job) {
        if ( job.finished_at === null ) {
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

    var msg = '';
    var token;


    // Create a special token based on the result of the job (this
    // is done so that the chance of that text existing in the log
    // is minimal / non-existent).

    if ( travis.CURRENT_JOB_TEST_RESULT === 0 ) {
        token = generateToken(travis.CURRENT_JOB_ID, configs.keys.SUCCESS);
        msg += 'Job succeeded (' + token + ')';
    } else {
        token = generateToken(travis.CURRENT_JOB_ID, configs.keys.FAILURE);
        msg += 'Job failed (' + token + ')';
    }


    // If the token is already present in the log, don't write
    // it again (this is done in order to reduce the output in
    // the case where this script is executed multiple times -
    // e.g.: the user uses multiple scripts that include this
    // script).

    if ( job.log.indexOf(token) === -1 ) {
        log(msg);
    }

}

function removeJob(jobs, id) {

    var result = [];

    jobs.forEach(function (job) {
        if ( job.id !== id ) {
            result.push(job);
        }
    });

    return result;

}

function thereIsAFailingJob(jobs)  {
    return jobs.some(function (job) {
        return job.result === 1 && job.allow_failure === false;
    });
}

function thereIsASuccessfulJob(jobs)  {
    return jobs.some(function (job) {
        return job.result === 0;
    });
}

function waitThenGetJobData(jobs) {

    var indexedJobList = {
        index: 0,
        jobs: jobs
    };

    var unfinishedJobs = getJobNumbersOfUnfinishedJobs(removeJob(indexedJobList.jobs, travis.CURRENT_JOB_ID));

    if ( unfinishedJobs.length !== 0 ) {
        log('Waiting for ' + unfinishedJobs.join(', ').replace(/,(?!.*,)/, ' and') + ' to finish...');
    }

    // If the jobs take longer to finish, gradually increase
    // the check interval time up to the specified limit.

    configs.checkInterval = ( configs.checkInterval * 2 > configs.CHECK_INTERVAL_LIMIT ?
                                configs.CHECK_INTERVAL_LIMIT : configs.checkInterval * 2 );

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

    log('handleJob(' + jobs.length + ' jobs)');
    log('handleJob(' + getJobNumbersOfJobs(jobs) + ')');
    log('handleJob(' + getIdsOfJobs(jobs) + ')');
    log('handleJob(' + getStatesOfJobs(jobs) + ')');
    // This just prints "[object Object]" for each job in the list.
    // log('handleJob(' + jobs + ')');
    log('handleJob: travis.CURRENT_JOB_ID = ' + travis.CURRENT_JOB_ID);

    var currentJob = getJob(jobs, travis.CURRENT_JOB_ID);
    if (currentJob === undefined) {
        log('handleJob: currentJob is undefined');
    }

    var leaderJob = jobs[jobs.length-1];

    log('I am ' + currentJob.number + ' with ID ' + travis.CURRENT_JOB_ID);
    log('leader job is ' + leaderJob.number + ' with ID ' + leaderJob.id);

    if ( currentJob.id !== leaderJob.id )  {
        endJob(2);
    }

    if ( currentJob.result === 1 ) {
        if ( currentJob.allow_failure === false ) {
            handleFailingJob(currentJob, jobs);
        } else {
            handleFailingJobAllowedToFail(currentJob, jobs);
        }
    } else {
        handleSuccessfulJob(currentJob, jobs);
    }

}

function handleFailingJob(currentJob, jobs) {

    // Since the current job failed, the build also failed, therefore,
    // the current job can be ended with the appropriate code.

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    var leaderJob = jobs[jobs.length-1];

    // If the current job is the leader job, assign it
    // to run the user-defined fail tasks.

    if ( currentJob.id !== leaderJob.id )  {
        log('handleFailingJob: This can\'t happen');
        endJob(2);
    }

    endJob(1);

}

function handleFailingJobAllowedToFail(currentJob, jobs) {

    // Since the current job failed, but it was allowed to fail,
    // the status of the build is unknown, therefore, the current
    // job can only be ended with the appropriate code if there is
    // enough information about the status of the other jobs.

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    var leaderJob = jobs[jobs.length-1];
    var otherJobs = removeJob(jobs, currentJob.id);


    if ( currentJob.id !== leaderJob.id )  {
        log('handleFailingJobAllowedToFail: This can\'t happen');
        endJob(2);
    }

    // If there is at least one job that failed, the build
    // failed.

    if ( thereIsAFailingJob(otherJobs) ) {
        endJob(1);
    }

    // Note: By this point it is known that currently there
    // aren't any jobs that were not allowed to fail and did
    // fail.

    if ( allJobsAreFinished(otherJobs) ) {

        // If there is a successful job, the build succeeded.

        if ( thereIsASuccessfulJob(otherJobs) ) {
            endJob(0);

        } else {

            // Otherwise, there are only jobs that were allowed
            // to fail and all of them fail, therefore, the build
            // failed, so assign the current job to run the user
            // defined fail tasks.

            endJob(1);
        }

    } else {

        // If this point is reached, it means a decision cannot
        // be made because there isn't enough information. So, we
        // need to wait a bit, check the status of the other jobs,
        // and try again.

        waitThenGetJobData(jobs);
    }

}

function handleSuccessfulJob(currentJob, jobs) {

    // Since the current job is a successful job, the status of the
    // build is unknown, therefore, the current job can only be ended
    // with the appropriate code if there is enough information about
    // the status of the other jobs

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    var leaderJob = jobs[jobs.length-1];
    var otherJobs = removeJob(jobs, currentJob.id);

    if ( currentJob.id !== leaderJob.id )  {
        log('handleSuccessfulJob: This can\'t happen');
        endJob(2);
    }

    // If a job failed, it means the build failed.

    if ( thereIsAFailingJob(otherJobs) ) {

        endJob(1);

    } else {

        // If all jobs are finished, it means the current job
        // is the first successful job in a successful build,
        // therefore, assign it to run the success tasks.

        if ( allJobsAreFinished(otherJobs) ) {
            endJob(0);

        } else {

            // If this point is reached, it means a decision cannot
            // be made because there isn't enough information. So, we
            // need to wait a bit, check the status of the other jobs,
            // and try again.

            waitThenGetJobData(jobs);
        }

    }

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
