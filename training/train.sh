#!/bin/bash
# usage: train.sh NAME BASE_LSTM BASE_TRAINEDDATA LISTTRAIN LISTEVAL ITERS [LR]
set -x
NAME=$1; BASE=$2; TDATA=$3; LT=$4; LE=$5; IT=$6; LR=${7:-0.0001}
OUT=./train/$NAME; mkdir -p $OUT
export OMP_THREAD_LIMIT=${OMPN:-3}
lstmtraining --continue_from $BASE --traineddata $TDATA --model_output $OUT/m --train_listfile $LT --eval_listfile $LE --max_iterations $IT --learning_rate $LR --target_error_rate 0.005 --debug_interval 0 > $OUT/train.log 2>&1
lstmtraining --stop_training --continue_from $OUT/m_checkpoint --traineddata $TDATA --model_output $OUT/$NAME.traineddata >> $OUT/train.log 2>&1
echo FINISHED >> $OUT/train.log
